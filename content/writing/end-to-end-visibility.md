---
title: "End-to-End Visibility: Knowing the Fate of Every Record"
subtitle: "Evidence, lag, absence, and the checks that let you find out before the customer does"
slug: end-to-end-visibility
date: 2026-12-02
series: every-record-accounted-for
part: 4
status: published
tags: [data-engineering, observability, reliability, slo, ingestion]
---

The worst way to learn that a file did not make it is an email from the customer.

On the platform I work on, that has happened more than once. A utility found missing enrollments in its own error report. A customer wrote in about dashboard data that had been missing for days. Each time, the pipeline had plenty of evidence: audit rows, counts, a chunk ledger, metrics, a partner report. None of it was arranged to answer the question that mattered: *is every record we were given accounted for, and if not, which ones aren't?*

The platform [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters. Nobody inspects files by hand at that volume. The system has to sort every input record into **confirmed**, **rejected**, **pending** or **unresolved**, and tell you when the fourth bucket grows. This final part is about making that sort trustworthy.

## The evidence comes in layers, and each layer is a different witness

Stop calling the traces a file leaves "the audit trail" and treat them as separate witnesses. Each saw a different part of the event, at a different time.

```
                    file lands
                        │
 L1  intake count ──────┤  side service reads the original file, counts records
                        │  (optional; a decryption failure writes a row with no count)
 L2  file milestones ───┤  received → processing → ingesting → reporting
 L3  chunk steps ───────┤  read (total = input lines)
     with counts        │  filtered & transformed (failed = transform failures)
                        │  ingested (total = passed, failed = write failures)
                        │  sent for reporting
 L4  chunk ledger ──────┤  chunked → lines failed | processing failed | successful
                        │          → archived → reported
 L5  failed lines ──────┤  per chunk, compressed, in object storage; streamed to warehouse
 L6  completion ────────┤  event per chunk → reporter (under a lock): archive file,
     event + reporter   │  write partner error report, mark chunks reported
 L7  metrics ───────────┤  records processed per customer, error counts
 L8  downstream ────────┘  aggregations ran, dashboards show the data
                        ┊
     destination ┄┄┄┄┄┄┄┄  distinct stored keys: what nothing above checks
```

L2 and L3 go to the analytics warehouse through a streaming delivery service. L4 lives in the operational database, L5 in object storage, L6 in a queue and a daemon, L7 in the cloud metrics service, L8 in other systems entirely. Different owners, different failure modes, and different clocks.

**Audit writes are best-effort.** If writing an audit row fails, the failure is logged and ingestion carries on. That is the right priority, since a bookkeeping hiccup should not stop ingestion. The price is that a missing row is ambiguous: the step never happened, or it happened and its receipt was lost.

**The counts are record identifiers, not rows.** "Ingested: 3" means the write handler reported success for three record IDs. Some transformers go further and check, inside the chunk, that every original record ID came out as a success or a failure, and can block ingestion if one went missing. That is a real reconciliation, but of the pipeline against itself. It never looks at storage.

## What each layer can prove, and what it cannot

When someone says "it shows as done", the right reply is "according to which layer?"

| Layer | Can prove | Cannot prove | When it is available |
|---|---|---|---|
| L1 Intake count | Records in the original file, before parsing | That "one line = one record" holds for this format | In parallel with ingestion; optional |
| L2 File milestones | The file entered each phase | That every chunk finished, or that records were stored | Many hours later (warehouse) |
| L3 Chunk steps | Each chunk's own read / transformed / ingested / failed counts | That writes produced distinct rows; that a missing row means missing work | Many hours later (warehouse) |
| L4 Chunk ledger | Current state of every chunk | Why a chunk is stuck; anything about stored rows | Immediately |
| L5 Failed lines | Which records were rejected, and why | Anything about records that were *not* rejected | Immediately in object storage |
| L6 Completion + reporter | The file was archived and the partner told about failures | That reporting will ever happen if an event is lost | When the last chunk's event is handled |
| L7 Metrics | Volume and error trends per customer | Whether low volume is a quiet day or a missing file | Close to real time |
| L8 Downstream | The data is usable by the product | Which file or record caused a gap | After downstream processing |
| Destination | Distinct keys actually stored | That stored values are correct | Whenever you run it |

L1 to L7 all describe *work done*. Only the last two rows describe *outcome*; L8 is too coarse to diagnose anything, and nothing in the standard pipeline runs the destination check.

Three rough edges change how you read a gap:

- A chunk's completion event is sent *before* its "sent for reporting" audit row is written. A chunk can be fully reported with that row missing.
- When the intake counter cannot decrypt a file, it writes a row with *no* count plus an error code, and raises a metric. "No count" and "zero records" are different findings; never merge them.
- Soft failures are records that appear as both a success and a failure. They need their own column, or they are double-counted one way and missed the other.

## Evidence arrives late, so verdicts must know the time

The audit trail reaches the warehouse many hours after the work it describes. In one test environment on one day, the newest audit row was about sixteen and a half hours old. That lag produces contradictions where every party tells the truth.

*Synthetic example.* A file finishes at 09:00. At 11:00:

```
chunk ledger (operational DB):     9/9 chunks reported
warehouse audit rows (lagged):     FILE RECEIVED only
partner error report:              delivered, 14 rejected lines
records-processed metric:          normal for this customer
```

The warehouse says stuck; the ledger says done. Both are accurate. They read different clocks.

The rule I'd build into every report and alert: **absence of evidence inside the lag window is not a verdict.** The reporting layer therefore has to know its own *watermark* (the newest evidence it holds) and print it.

```text
verdict(file, now):
  wm = warehouse_watermark()
  if file.arrived_at > wm:
      return PENDING("evidence not yet arrived; watermark " + wm)
  if ledger.any_chunk_unfinished_since(now - T_stuck):
      return UNRESOLVED("started, not finished after " + T_stuck)
  if ledger.all_chunks_reported(file) and counts_balance(file):
      return CONFIRMED_BY_PIPELINE      # not yet destination-confirmed
  return PENDING
```

Note the careful word. Balanced counts confirm the *pipeline's account*, not stored rows; the destination check below exists for the difference. And anything time-sensitive belongs on the ledger, which is immediate. The warehouse is for history and trends, not for "is this file stuck right now?"

## Detecting absence: failures that never report themselves

Monitoring watches for things that happen. The incidents that hurt most here were things that *didn't*. Absence has at least three shapes, each needing its own detector.

### Shape 1: started, never finished

The hub post described worker threads that died from an `Error` nothing caught. Such a chunk gets its "processing" and "ingesting" markers, which carry no counts and mean only *I started*. Then nothing: no "ingested" row, no ledger update, no completion event, no failed lines, no partner report. Every downstream signal is triggered by completion, so all of them stay quiet.

*Synthetic example.* Chunk 7 of 9:

```
chunk 7:           PROCESSING ✔  INGESTING ✔  READ —  INGESTED —   ledger: chunked
chunks 1–6, 8, 9:  all steps ✔                                      ledger: successful
file:              "all chunks processed?" → false, forever
```

"Chunked" should be a short-lived state, so a chunk sitting there for hours is a finding. The detector is a sweep, not an event handler:

```text
every 15 min:
  for chunk in ledger where status in (chunked, processing_failed)
                       and updated_at < now - T_stuck(file_type):
      raise STUCK_CHUNK(file, chunk, age)
```

`processing_failed` belongs in the sweep too. As far as I can tell from the code, the reporter acts only when every chunk has reached "processed" (successful or lines-failed). A chunk that failed permanently stops its file from ever being archived or reported. I could not find a sweeper for either state. That is a search of the paths I read, not proof that none exists.

### Shape 2: the completion event that never arrived

Reporting is event-driven. Each chunk sends a completion event as it finishes. A reporter daemon checks the ledger, and once every chunk is processed it takes a distributed lock, archives the file, writes the partner error report and marks the chunks reported.

That is cheap and prompt, with one blind spot: **nothing else re-triggers reporting.** Lose the last chunk's event and nobody looks at that file again. Three behaviours widen the gap:

- The lock is tried once, with no wait. A reporter that cannot get it skips the event and the message is consumed. Fine if the lock holder succeeds; not fine if it then fails.
- A failure while reporting is logged and the message is still consumed, so queue redelivery, the at-least-once safety net from the hub post, does not apply.
- Streaming error rows to the warehouse has its own error handling. If it fails, the chunks are still marked reported.

In September 2026 this happened for real. With the client version then in use, completion messages did not reach the reporter. Account data was unavailable and dashboards failed for several customers; one customer reported dashboard data missing for days. Recovery meant restarting workers to clear in-memory caches, requesting a rollback of the client version, and several hours of catch-up for pending files. Detection came from customer reports.

The detector joins two things that already exist:

```text
files where all chunks processed
        and no chunk archived or reported
        and last chunk update < now - T_report
  → LOST_COMPLETION(file)
```

The remedy is to re-send the last chunk's completion event. Reporting takes a lock and checks "already reported" first, so a replay is safe. The hard part is organisational: someone has to own a sweep in a system built to run on events.

### Shape 3: the file that never came

The quietest failure is upstream. A partner's export fails, or a file arrives with a plausible but wrong name prefix and is never picked up for its type. The pipeline sees nothing, so it records nothing.

Only an *expectation* can catch this. Most partners send on a schedule that is knowable even when nobody wrote it down:

```text
expected_files: (customer, file_type, cadence, window, typical_size_range)

hourly:
  for e in expected_files where now > e.window_end + grace:
      if no file received for (e.customer, e.file_type) in window:
          raise MISSING_FILE(e)
      elif received size outside e.typical_size_range:
          raise SUSPICIOUS_VOLUME(e)
```

Today's alerting catches this indirectly: it fires on records-processed metrics per customer, so a missing file shows up as low volume. But low volume has several explanations and the alert cannot tell them apart. That job falls to triage, below.

## Checking the destination: distinct keys, not successful writes

Every layer above describes work. To confirm an outcome you have to read what was stored.

As the hub post showed, interval readings are upserted on a key of meter, time bucket and reading timestamp, so two different source records that resolve to the same key collapse silently. That property is what makes retries safe, so it stays. What you can do is count against it, comparing **distinct keys the accepted input should produce** with **distinct keys present in storage**.

*Synthetic example.* One chunk of a nightly interval file covering the night the clocks go back:

| Measure | Count | Source |
|---|---|---|
| Lines read | 9,600 | L3 |
| Rejected (transform) | 24 | L3 / failed lines |
| Ingested (writes succeeded) | 9,576 | L3 |
| Distinct keys derived from accepted input | 9,552 | normalise each record to its storage key |
| Distinct keys found in storage | 9,552 | read back |
| **Collapsed** (writes − distinct input keys) | **24** | difference |
| **Missing** (distinct input keys − stored keys) | **0** | difference |

The pipeline balances: 9,600 = 9,576 + 24. The destination check finds two facts it could not. Twenty-four accepted records collapsed onto keys other records also used; in a DST file, that is an hour of readings for 24 meters, overwritten. And no keys are missing. The two numbers send you to different owners. Collapsed keys are a contract or time-zone problem with the partner. Missing keys are ours.

Reading back every key at a terabyte a day would double the read load on a database that ingestion already leans on. Two compromises make it affordable:

- **Count distinct input keys at ingest time.** The worker already holds every transformed record. A per-chunk distinct-key count next to the existing counts costs one hash set per chunk and catches collapses with no extra reads.
- **Read back on a sample.** Pick a deterministic sample of meters per file, read their stored keys for the file's range, compare. Run it off-peak behind a rate limit, and remember that older buckets now live in object storage, not the database.

## Queue depth tells you about work; message age tells you about customers

Downstream queues are where visibility misled us most. Autoscaling watched visible depth. Depth is a fine capacity signal and a poor impact signal, because Little's law ties it to wait time through throughput:

```
wait ≈ depth ÷ throughput
```

Two cases, from incident figures plus arithmetic:

- **A flood depth sees and misreads.** An aggregation queue once held about 12 million messages while throughput was roughly 500 messages per five minutes, against a normal 2–3 million a day. 500 per five minutes is 144,000 a day, so 12 million is about 83 days of work. Depth shows a big number. Age would have shown a wall.
- **A starvation depth cannot see.** In the hub post's noisy-neighbour incident, one utility's work waited more than 48 hours behind another's burst in a shared queue group. A depth alarm sees one number for the group. The waiting utility's experience was the age of *its own* oldest message.

Two subtleties from the code:

- **Visible depth excludes in-flight messages.** Workers take messages ahead of free threads, up to twice their pool size, and the visibility timer starts at receipt. A slow message can reappear while still waiting for a thread, so a backlog can look busy while it cycles.
- **The platform's age metric is age at dequeue.** Messages are stamped when sent and bucketed on receipt, from under a second to over three days. Useful, but it reports only on messages someone *received*. A queue with no consumer emits no age data, and a stuck message reports its age only when it finally comes out. Alerting needs *oldest visible message age*, sampled from the queue.

| Signal | Alert when | Catches |
|---|---|---|
| Oldest message age, per queue *and* partition | above the lane's target | starvation, stalled consumers |
| Depth ÷ throughput | projected drain time above target | floods, before they become backlogs |
| Dead-letter depth | above zero on a lane that should be clean | poison messages |

A backlog depth-and-age alerting proposal came out of the 48-hour delay. It is the right direction, and it needs per-partition coverage: a queue the alarms don't name can be on fire while every named queue looks healthy.

## What we could see in 2024, and how triage works now

An internal observability review in 2024 shows where the gaps were:

| Area | State in the 2024 review |
|---|---|
| Queue depth / lag (cloud metrics) | Done |
| Throughput via queue metrics | Done |
| Database connection-pool metrics | Done |
| Message age / time in queue | To do |
| End-to-end processing latency | To do |
| Processing error rates | To do |
| Queue error rates, incl. dead-letter alerting | To do |
| Streaming-delivery errors and latency | To do |
| Distributed and error tracing | To do (per-module trace IDs only) |
| Logs | Partial: in object storage, queried with SQL, no real-time view |

Everything done measures *how much work is moving*. Everything to-do measures *how long a customer waits* or *what went wrong*.

In 2026 on-call works from an alert runbook. Alerts fire on records-processed metrics per customer, with thresholds and durations that differ by customer and must be read from configuration, not assumed. Triage walks down the evidence layers:

```
alert: customer X records-processed below threshold for duration D
  ├─ 1. Did the file arrive?              no → upstream / missing file
  ├─ 2. Did chunk ingestion run?          no → stuck chunks, worker health
  ├─ 3. Did chunk reporting complete?     no → completion / reporter path
  ├─ 4. What failed, and why?             → failed lines, error codes
  ├─ 5. Are services and queues healthy?  → depth, age, dead letters
  └─ 6. After reprocessing, revalidate the same metric
```

The engineer must separate four explanations for the same alert: **low expected volume** (close it), **a missing upstream file** (contact the partner), **a processing failure** (fix and reprocess), or **a transient** (record it, watch for repeats).

The walk is sound. Its constraint is that a person runs it at alert time, against evidence that may be hours stale. The detectors in this post are the same walk as standing queries: step 1 is the expected-file check, steps 2 and 3 are the stuck-chunk and lost-completion sweeps, step 6 is the per-file ledger below.

## When the customer noticed first

Generalised, the pattern across this series' incidents looks like this:

| What happened | How it surfaced | Why our signals missed it |
|---|---|---|
| About two days of enrollments missing (2023) | The utility, from its own error report | Failures went *to the partner*; nothing alerted internally |
| Shared downstream queue at ~30M messages (2024) | Usage missing from dashboards for about nine days | Depth was visible; nothing turned it into wait time |
| One utility's work behind another's for 48+ hours | A routine production check, not an alert | Per-partition age was not measured |
| Completion messages lost with a client version (2026) | Reports from several customers | Reporting runs on events; a missing event emits nothing |
| Daily status showed "incomplete" while data was present (2026) | Readers of the status report | Reporting can be wrong in *both* directions |

The last row matters as much as the rest. A report that cries "incomplete" about complete data teaches everyone to ignore it, and on the day it is right, nobody acts. False negatives cost data; false positives cost the trust you need to act on the next true positive.

Each miss was a signal measuring *activity* where the customer experienced *outcome*. The lesson is not "add alerts". It is that the partner's view and ours should come from the same ledger. If the partner can see 24 rejected records, our monitoring should have seen them first.

## Proposed SLOs: freshness, completeness, correctness

A 2026 monitoring initiative lists data-freshness monitoring as an objective; I have not found a committed freshness SLO. What follows is a **recommendation**, and the numbers are **synthetic**.

- **Freshness:** time from file *arrival* (not processing start, because queue wait is what customers feel) to all records confirmed.
- **Completeness:** the share of input records that end confirmed or rejected rather than unresolved. This gives the fourth bucket a budget.
- **Correctness (sampled):** stored distinct keys match expected keys, and sampled values match the source after documented transforms.

*Synthetic SLO table (illustrative values only):*

| SLO | SLI | Target | Window |
|---|---|---|---|
| Freshness, routine | files with all chunks reported within 6 h of arrival | 95% | 28 days |
| Freshness, backfill | backfill files reported within 72 h of arrival | 90% | 28 days |
| Completeness | records unresolved 24 h after arrival ÷ records received | ≤ 0.01% | 28 days |
| Correctness, keys | sampled files where stored distinct keys = expected | 99.5% | 28 days |
| Correctness, values | sampled records matching source after transforms | 99.9% | 28 days |

Constraints to design around:

- **Separate lanes, separate targets.** One freshness target for backfills and overnight files either pages on every backfill or tolerates a stale morning.
- **Compute freshness from the ledger**, or start the window at the watermark. A warehouse-based SLI breaches because of the lag.
- **The intake count is optional** and treats a line as a record. Without it, the completeness denominator falls back to lines read, which cannot see a file truncated before chunking.
- **Correctness costs reads.** Sample size comes from what the database absorbs off-peak.

## A per-file reconciliation ledger

The checks above read from stores with different clocks. One row per file ties them together. A small scheduled reconciler writes it, off the hot path, so its failures cannot slow ingestion, and it refuses to say "confirmed" until the evidence does.

```
file_reconciliation
  file_id, customer, file_type, lane
  arrived_at, expected_by                       ← expected-file schedule
  intake_count, intake_status                   ← L1: count | no-count+error | absent
  chunks_total, chunks_by_status                ← L4, live
  lines_read, transform_failed, ingest_failed, soft_failed   ← L3
  distinct_input_keys                           ← new, per chunk at ingest
  stored_keys_sampled, stored_keys_matched      ← destination sample
  rejected_lines_stored, reported_at            ← L5, L6
  evidence_watermark                            ← newest L2/L3 row seen
  state, reason, last_evaluated_at
```

The invariant it enforces:

```
intake_count = confirmed + rejected + pending + unresolved
```

| Condition | State |
|---|---|
| Expected file absent past grace | `MISSING` |
| Arrived after the watermark, or chunks younger than T_stuck | `PENDING` |
| Chunk unfinished after T_stuck | `UNRESOLVED(stuck chunk)` |
| All processed, none reported after T_report | `UNRESOLVED(lost completion)` |
| Lines read ≠ intake count | `UNRESOLVED(count mismatch)` |
| Sampled stored keys ≠ expected | `UNRESOLVED(destination mismatch)` |
| Distinct input keys < ingested | add a collapse finding |
| All balanced, report delivered | `CONFIRMED` or `CONFIRMED_WITH_REJECTIONS` |

*Synthetic example row:*

```
nightly-intervals, customer A, routine lane
arrived 02:10       intake_count 120,000     chunks 12/12 (11 successful, 1 lines_failed)
lines_read 120,000  transform_failed 310     ingest_failed 0   soft 0
distinct_input_keys 119,690                  stored sample 400/400 matched
reported 03:05      partner report: 310 lines
watermark 23:40 prev day → warehouse rows not in yet; ledger used
state: CONFIRMED_WITH_REJECTIONS
```

Three choices carry the weight. **The reconciler is scheduled**, because an event-driven system cannot notice that an event never fired. **Reasons are first-class**: a lost completion and a count mismatch go to different owners, and a bare "incomplete" is the report people learned to ignore. **The partner's report and the ledger share numbers**: if the partner sees 310 rejected lines, so do we.

The reconciler must itself be watched: `last_evaluated_at` needs a freshness alert, or it becomes one more silent stop.

## Every record, accounted for

This series followed one file through arrival, chunking, queues, processing, delivery, storage, fan-out and evidence, and the same idea kept returning.

At arrival, a wrongly named file produced no error because, to the pipeline, nothing had arrived. In the workers, a thread died outside every `catch` and left a chunk that started and never finished. In the queues, a utility waited two days behind a neighbour. In storage, two successful writes left one row. In reporting, a lost event left a file that would never be reported. Each time, every component was healthy by its own measure, and the gap sat *between* them, in a question none of them was asked.

Visibility is asking that question on purpose: knowing what each witness could have seen and when it reports, looking for what didn't happen, checking the destination, and keeping one ledger per file that you and the partner both read.

None of this makes the pipeline fail less. At a terabyte a day, something fails every hour. What it changes is who finds out first.
