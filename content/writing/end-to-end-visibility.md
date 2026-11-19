---
title: "End-to-End Visibility: Knowing the Fate of Every Record"
subtitle: "Witnesses, lag, absence, and the checks that let you find out before the customer does"
slug: end-to-end-visibility
date: 2026-12-02
series: every-record-accounted-for
part: 4
status: published
tags: [data-engineering, observability, reliability, slo, ingestion]
---

The worst way to learn that a file did not make it is an email from the customer.

The second worst is the partner's own error report: they count the rejections you sent them, notice records that were neither accepted nor rejected, and ask where those went. In the failure pattern I mean, the pipeline usually has plenty of evidence: audit rows, counts, a chunk ledger, metrics, a partner report. None of it is arranged to answer the question that matters: *is every record I was given accounted for, and if not, which ones aren't?*

The platform [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters. Nobody inspects files by hand at that volume. A pipeline at that scale has to sort every input record into **confirmed**, **rejected**, **pending** or **unresolved**, and tell you when the fourth bucket grows. This final part of the [series](/writing/every-record-accounted-for) is about making that sort trustworthy. The examples are simplified or made up; the rules are the point.

## The evidence comes in layers, and each layer is a different witness

Stop calling the traces a file leaves "the audit trail" and treat them as separate witnesses. Each saw a different part of the event, at a different time.

```
                    file lands
                        │
 W1  intake count ──────┤  independent count of records in the original file (optional)
 W2  audit trail ───────┤  file entered each phase; per chunk: lines read,
                        │  transform failures, records written, write failures
 W3  chunk ledger ──────┤  current state of every chunk:
                        │  queued → started → done | failed → reported
 W4  rejected records ──┤  which records failed, and why
 W5  reporting ─────────┤  per-chunk completion event → reporter: archive file,
                        │  send partner error report, mark chunks reported
 W6  product signals ───┘  records-processed metrics, aggregations, dashboards
                        ┊
     destination ┄┄┄┄┄┄┄┄  distinct stored keys: what nothing above checks
```

In a typical design these live in different places: the audit trail ships to an analytics warehouse in batches, the ledger sits in the operational database, rejected records in object storage, reporting in a queue and a daemon, metrics in a metrics service, and downstream signals in other systems entirely. Different owners, different failure modes, different clocks.

**Audit writes should be best-effort**, and that choice has a price. A bookkeeping hiccup should not stop ingestion, so a failed audit write is logged and the work carries on. But then a missing row is ambiguous: the step never happened, or it happened and its receipt was lost.

**Counts usually describe record identifiers, not rows.** "Written: 3" means the write handler reported success for three record IDs. A transformer can go further and check, inside the chunk, that every original record ID came out as a success or a failure, and block the write if one went missing. That is a real reconciliation, but of the pipeline against itself. It never looks at storage.

## What each layer can prove, and what it cannot

When someone says "it shows as done", the right reply is "according to which witness?"

| Witness | Can prove | Cannot prove | When it is available |
|---|---|---|---|
| W1 Intake count | Records in the original file, before parsing | That "one line = one record" holds for this format | In parallel with ingestion, if it runs at all |
| W2 Audit trail | The file entered each phase; each chunk's own counts | That every chunk finished; that writes produced distinct rows; that a missing row means missing work | Hours later, if shipped to a warehouse in batches |
| W3 Chunk ledger | Current state of every chunk | Why a chunk is stuck; anything about stored rows | Immediately |
| W4 Rejected records | Which records were rejected, and why | Anything about records that were *not* rejected | Immediately |
| W5 Reporting | The file was archived and the partner told about failures | That reporting will ever happen if an event is lost | When the last chunk's event is handled |
| W6 Product signals | Volume trends; the data is usable by the product | Whether low volume is a quiet day or a missing file; which record caused a gap | Near real time to hours |
| Destination | Distinct keys actually stored | That stored values are correct | Whenever you run it |

W1 to W5 all describe *work done*. Only the last two rows describe *outcome*. Product signals are too coarse to diagnose anything, and most pipelines never run the destination check at all.

Three ordering and counting details change how you read a gap:

- If a chunk's completion event is sent *before* its final audit row is written, a chunk can be fully reported with that row missing. Either write the receipt first or treat its absence as weak evidence.
- When an intake counter cannot read a file at all, it should record *no count* plus a reason, not zero. "No count" and "zero records" are different findings; never merge them.
- Soft failures are records that appear as both a success and a failure. They need their own column, or they are double-counted one way and missed the other.

## Evidence arrives late, so verdicts must know the time

A batched audit trail reaches the warehouse hours after the work it describes. That lag produces contradictions where every party tells the truth.

*Synthetic example.* A file finishes at 09:00. At 11:00:

```
chunk ledger (operational DB):     9/9 chunks reported
warehouse audit rows (lagged):     FILE RECEIVED only
partner error report:              delivered, 14 rejected lines
records-processed metric:          normal for this customer
```

The warehouse says stuck and the ledger says done, and both are accurate because they read different clocks.

The rule I'd build into every report and alert: **absence of evidence inside the lag window is not a verdict.** The reporting layer has to know its own *watermark* (the newest evidence it holds) and print it. Time-sensitive questions go to the ledger, which is immediate; the watermark only gates conclusions that need the lagged counts.

```text
verdict(file, now):
  if ledger.any_chunk_unfinished(file, older_than = now - T_stuck):
      return UNRESOLVED("started, not finished after " + T_stuck)
  if not ledger.all_chunks_reported(file):
      return PENDING("chunks still in progress")
  wm = warehouse_watermark()
  if file.finished_at > wm:
      return PENDING("counts not in warehouse yet; watermark " + wm)
  if counts_balance(file):
      return CONFIRMED_BY_PIPELINE      # not yet destination-confirmed
  return UNRESOLVED("counts do not balance")
```

The ledger checks run first, so a stuck file is flagged even when it is newer than the watermark. Balanced counts confirm the *pipeline's account*, not stored rows; the destination check below exists for the difference. The warehouse is for history and trends, not for "is this file stuck right now?"

## Detecting absence: failures that never report themselves

Monitoring watches for things that happen. The failures that hurt most in pipelines like this are things that *didn't*. Absence has at least three shapes, each needing its own detector.

### Shape 1: started, never finished

The [hub post](/writing/every-record-accounted-for) described the pattern of a worker thread that dies from an `Error` nothing catches. Such a chunk gets its "started" markers, which carry no counts and mean only *I began*. Then nothing: no counts, no ledger update, no completion event, no rejected records, no partner report. Every downstream signal is triggered by completion, so all of them stay quiet.

*Synthetic example.* Chunk 7 of 9:

```
chunk 7:           STARTED ✔  READ ·  WRITTEN ·      ledger: started
chunks 1–6, 8, 9:  all steps ✔                        ledger: done
file:              "all chunks finished?" → false, forever
```

"Started" should be a short-lived state, so a chunk sitting there for hours is a finding. The detector is a sweep, not an event handler:

```text
every 15 min:
  for chunk in ledger where status in (started, failed)
                       and updated_at < now - T_stuck(file_type):
      raise STUCK_CHUNK(file, chunk, age)
```

`failed` belongs in the sweep too. A reporter that waits until every chunk is done will wait forever on a chunk that failed permanently, and the file is never archived or reported. Any terminal state that blocks reporting needs either a sweep or an explicit path to "reported with failures".

### Shape 2: the completion event that never arrived

Event-driven reporting is a common design. Each chunk sends a completion event as it finishes. A reporter checks the ledger, and once every chunk is done it takes a distributed lock, archives the file, writes the partner error report and marks the chunks reported.

That is cheap and prompt, with one blind spot: **if nothing else re-triggers reporting, a lost final event means nobody looks at that file again.** The fix is in how the reporter treats failure:

- Reporting must survive lock contention and its own failures: if the lock is taken or reporting fails, leave the message for redelivery (the at-least-once safety net from [Part 3](/writing/distributed-pipeline-reliability)), and mark chunks reported only after every side delivery succeeds.

Suppose completion events stop reaching the reporter for any reason: a misrouted topic, a consumer that is quietly not running. Every file finishes processing, none is reported, and no alert fires, because the only thing that would have spoken is the missing event.

The detector joins two things that already exist:

```text
files where all chunks done
        and no chunk archived or reported
        and last chunk update < now - T_report
  → LOST_COMPLETION(file)
```

The remedy is to re-send the last chunk's completion event. If reporting takes a lock and checks "already reported" first, a replay is safe. The hard part is organisational: someone has to own a sweep in a system built to run on events.

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

Per-customer volume alerts catch this only indirectly: a missing file shows up as low volume. But low volume has several explanations and the alert cannot tell them apart. That job falls to triage, below.

## Checking the destination: distinct keys, not successful writes

Every witness above describes work. To confirm an outcome you have to read what was stored.

As the hub post showed, if interval readings are upserted on a key derived from the meter and the reading time, two different source records that resolve to the same key collapse silently. That property is what makes retries safe, so it stays. What you can do is count against it, comparing **distinct keys the accepted input should produce** with **distinct keys present in storage**.

*Synthetic example.* One chunk of a nightly file of hourly readings, covering the night the clocks go back:

| Measure | Count | Source |
|---|---|---|
| Lines read | 9,600 | W2 |
| Rejected (transform) | 24 | W2 / W4 |
| Written (writes succeeded) | 9,576 | W2 |
| Distinct keys derived from accepted input | 9,552 | normalise each record to its storage key |
| Distinct keys found in storage | 9,552 | read back |
| **Collapsed** (writes − distinct input keys) | **24** | difference |
| **Missing** (distinct input keys − stored keys) | **0** | difference |

The pipeline balances: 9,600 = 9,576 + 24. The destination check finds two facts it could not. Twenty-four accepted records collapsed onto keys other records also used; with hourly readings, that is the repeated hour for 24 meters, overwritten. At 15-minute resolution the same 24 would be the repeated hour for 6 meters. And no keys are missing. The two numbers send you to different owners: collapsed keys are a contract or time-zone question for the partner, and missing keys belong to the pipeline.

Reading back every key would add a read for every write, on a database that ingestion already leans on. Two compromises make it affordable:

- **Count distinct input keys at ingest time.** The worker already holds every transformed record. A per-chunk distinct-key count next to the existing counts costs one hash set per chunk and catches collapses with no extra reads.
- **Read back on a sample.** Pick a deterministic sample of meters per file, read their stored keys for the file's range, compare. Run it off-peak behind a rate limit, and if older data is tiered to cheaper storage, remember that the read path differs.

## Queue depth tells you about work; message age tells you about customers

[Part 3](/writing/distributed-pipeline-reliability) worked through the arithmetic: by Little's law, wait ≈ depth ÷ throughput, so a big depth can mean minutes or months depending on the drain rate, and one tenant can starve behind another's burst while the shared depth number looks unremarkable. Depth is a fine capacity signal and a poor impact signal. For visibility, two pitfalls matter on top of that:

- **Visible depth excludes in-flight messages.** If consumers prefetch more messages than they have free threads, and the visibility timer starts at receipt, a slow message can reappear while still waiting for a thread. A backlog can look busy while it cycles.
- **Age measured at dequeue reports only on messages someone received.** Stamping messages when sent and recording their age on receipt is useful, but a queue with no consumer emits no age data, and a stuck message reports its age only when it finally comes out. Alerting needs *oldest visible message age*, sampled from the queue itself.

| Signal | Alert when | Catches |
|---|---|---|
| Oldest message age, per queue *and* partition | above the lane's target | starvation, stalled consumers |
| Depth ÷ throughput | projected drain time above target | floods, before they become backlogs |
| Dead-letter depth | above zero on a lane that should be clean | poison messages |

Coverage matters as much as the signal: generate alarms from the routing configuration rather than by hand, so no queue or partition goes unwatched.

## Triage as a walk down the witnesses

In my experience, teams usually instrument volume first, and wait time and errors later. Volume tells you work is moving; it does not tell you how long a customer waits or what went wrong.

So an alert on low records-processed volume needs a triage path. Here is the one I'd propose, walking down the witnesses:

```
alert: customer X records-processed below threshold for duration D
  ├─ 1. Did the file arrive?              no → upstream / missing file
  ├─ 2. Did chunk ingestion run?          no → stuck chunks, worker health
  ├─ 3. Did chunk reporting complete?     no → completion / reporter path
  ├─ 4. What failed, and why?             → rejected records, error codes
  ├─ 5. Are services and queues healthy?  → depth, age, dead letters
  └─ 6. After reprocessing, revalidate the same metric
```

The engineer must separate four explanations for the same alert: **low expected volume** (close it), **a missing upstream file** (contact the partner), **a processing failure** (fix and reprocess), or **a transient** (record it, watch for repeats).

The walk is sound, but a person runs it at alert time against evidence that may be hours stale. The detectors in this post are the same walk as standing queries: step 1 is the expected-file check, steps 2 and 3 are the stuck-chunk and lost-completion sweeps, step 6 is the per-file ledger below.

## When the customer notices first

These are composite failure shapes, not reports of specific events:

| Failure shape | How it tends to surface | Why activity signals miss it |
|---|---|---|
| Records rejected and reported only to the partner | The partner's own error report | Failures flow outward; nothing alerts internally |
| A shared downstream queue backs up | Data missing from dashboards | Depth is visible; nothing turns it into wait time |
| One tenant's work stuck behind another's burst | A manual check, not an alert | Per-partition age is not measured |
| Completion events stop arriving | Customers asking about missing reports | Reporting runs on events; a missing event emits nothing |
| Status says "incomplete" while the data is present | Readers of the status report | Reporting can be wrong in *both* directions |

The last row matters as much as the rest. A report that cries "incomplete" about complete data teaches everyone to ignore it, so on the day it is right, nobody acts, and the next real gap costs data.

Each miss is a signal measuring *activity* where the customer experiences *outcome*. More alerts will not fix that; what fixes it is giving the partner's view and the internal view the same ledger. If the partner can see 24 rejected records, your monitoring should have seen them first.

## Proposed SLOs: freshness, completeness, correctness

What follows is my **recommendation**, and the numbers are **synthetic**.

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
- **An intake count is often optional** and treats a line as a record. Without it, the completeness denominator falls back to lines read, which cannot see a file truncated before chunking.
- **Correctness costs reads.** Sample size comes from what the database absorbs off-peak.

## A per-file reconciliation ledger

The checks above read from stores with different clocks. One row per file ties them together. A small scheduled reconciler writes it, off the hot path, so its failures cannot slow ingestion, and it refuses to say "confirmed" until the evidence does.

```
file_reconciliation
  file_id, customer, file_type, lane
  arrived_at, expected_by                       ← expected-file schedule
  intake_count, intake_status                   ← W1: count | no-count+reason | absent
  chunks_total, chunks_by_status                ← W3, live
  lines_read, transform_failed, write_failed, soft_failed    ← W2
  distinct_input_keys                           ← new, per chunk at ingest
  stored_keys_sampled, stored_keys_matched      ← destination sample
  rejected_lines_stored, reported_at            ← W4, W5
  evidence_watermark                            ← newest W2 row seen
  state, reason, last_evaluated_at
```

The invariant it enforces:

```
records_in = confirmed + rejected + pending + unresolved
```

`records_in` is the intake count when one exists and lines read otherwise, and the row records which was used. Soft failures are counted once, as rejected, so they cannot land in two buckets. Collapsed records still sit inside "confirmed", because their writes succeeded; the collapse is a separate finding attached to the row, not a fifth bucket.

| Condition | State |
|---|---|
| Expected file absent past grace | `MISSING` |
| Arrived after the watermark, or chunks younger than T_stuck | `PENDING` |
| Chunk unfinished after T_stuck | `UNRESOLVED(stuck chunk)` |
| All done, none reported after T_report | `UNRESOLVED(lost completion)` |
| Lines read ≠ intake count | `UNRESOLVED(count mismatch)` |
| Sampled stored keys ≠ expected | `UNRESOLVED(destination mismatch)` |
| Distinct input keys < written | add a collapse finding |
| All balanced, report delivered | `CONFIRMED` or `CONFIRMED_WITH_REJECTIONS` |

*Synthetic example row:*

```
nightly-intervals, customer A, routine lane
arrived 02:10       intake_count 120,000     chunks 12/12 (11 clean, 1 with rejections)
lines_read 120,000  transform_failed 310     write_failed 0   soft 0
distinct_input_keys 119,690                  stored sample 400/400 matched
reported 03:05      partner report: 310 lines
watermark 23:40 prev day → warehouse rows not in yet; ledger used
state: CONFIRMED_WITH_REJECTIONS
```

Three choices carry the weight. **The reconciler is scheduled**, because an event-driven system cannot notice that an event never fired. **Reasons are first-class**: a lost completion and a count mismatch go to different owners, and a bare "incomplete" is the report people learn to ignore. **The partner's report and the ledger share numbers**: if the partner sees 310 rejected lines, so does the ledger.

The reconciler must itself be watched: `last_evaluated_at` needs a freshness alert, or it becomes one more silent stop.

## Every record, accounted for

Across this series, every component in each failure was healthy by its own measure, and the gap sat *between* them, in a question none of them was asked. Visibility means asking that question on purpose: knowing what each witness could have seen and when it reports, looking for what didn't happen, checking the destination, and keeping one ledger per file that you and the partner both read.

None of this makes the pipeline fail less. What it changes is who finds out first.

*Views are my own. Examples are simplified or made up and do not describe any specific employer or customer system.*
