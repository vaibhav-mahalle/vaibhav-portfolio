---
title: "Every Record Accounted For"
subtitle: "Following one smart-meter file through a terabyte-a-day ingestion pipeline"
slug: every-record-accounted-for
date: 2026-11-20
status: published
tags: [data-engineering, distributed-systems, reliability, ingestion]
---

Here is a file with two meter readings in it. Both pass validation. Both are written successfully. The pipeline reports *2 records ingested, 0 failed*.

Storage holds one row.

Nothing crashed, nothing retried, no alert fired. Every component did exactly what it was designed to do. To understand how that happens, and why it is not simply a bug, you have to follow a file through the whole system.

The utility-analytics platform I work on [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters. Very little of it arrives as a tidy event stream. It arrives as files: interval readings, bills, customer enrollments, sent by utilities on their schedule, in their format, often many megabytes or gigabytes at a time.

This post follows one of those files from the moment it lands to the moment someone asks *did it work?* At each stage I'll describe what gets hard at this volume, the design choice that handles it, and a failure that shows where that choice stops protecting you.

```
partner file (SFTP / object storage)
  │
  ├─ 1. arrival ............ pick up, decrypt, identify type from the name
  ├─ 2. chunking ........... split into chunks, one unit of work each
  ├─ 3. queues ............. normal and priority lanes, bounded worker pools
  ├─ 4. processing ......... parse → validate → transform → look up customer → write
  ├─ 5. delivery ........... acknowledge only on success; retry on failure
  ├─ 6. storage ............ recent data in a database, history in object storage
  ├─ 7. fan-out ............ trigger downstream analytics for affected customers
  └─ 8. evidence ........... audit milestones, counts, failed lines, partner report
```

---

## 1. Arrival: you do not control the sender

The first hard fact about file ingestion is that the producer is outside your system. You cannot deploy a fix to a utility's export job. You negotiate a contract (file names, delimiters, column positions, date formats, time zones, units) and then you discover where reality differs from the contract.

Some of those differences fail loudly: a missing column, an unparseable date. The dangerous ones fail quietly. On one entry path, the file *type* is derived from a prefix in the file name. A file with a plausible but wrong prefix is not rejected; it is simply never picked up for that type. Nothing errors, because from the pipeline's point of view nothing arrived.

Time is the worst offender, because a wrong time-zone assumption produces *valid* timestamps. I'll come back to this in the storage section; it is how the opening example happens.

**Lesson:** the contract with the producer is part of your system's design, even though you don't run the producer. Write it down, especially the time rules, and test it with ugly dates.

---

## 2. Chunking: making a large file into many small units of work

A single file can hold millions of rows for hundreds of thousands of customers. Processing it as one unit would mean one slow worker, one giant retry if anything fails, and one giant blast radius.

So the first real step is to split the file into **chunks**. Chunk size is configured per file type, because a row of 15-minute interval readings and a row of billing data cost very different amounts to process. Each chunk becomes an independent unit of work:

- its own queue message,
- its own status as it moves through the pipeline (chunked, processing, lines failed, processed, archived, reported),
- its own error file of rejected lines,
- its own retry.

A bad chunk does not block a good one, and a retry repeats a few thousand rows, not a whole file.

### Memory has to be bounded too

Chunking solves the *work* problem. It does not automatically solve the *memory* problem. The original chunking path reads all of a file's records into memory and then slices them into chunks. That is fine for typical files and dangerous for unusually large ones. A streaming mode exists, but it is opt-in per configuration.

The sharper lesson came from somewhere less obvious: **the error path**. At the end of processing, failed lines are collected into a report for the partner, encrypted and written out. That report used to be built in memory. On a normal day the error count is small. On the day a partner sends a malformed file, the error count is proportional to the file size, and the process that builds the report runs out of memory, taking ingestion for *other* customers down with it.

The fix streams errors to disk as they are produced. In testing with a 1 GB heap, a file with about a million bad lines crashed the old code and ran without trouble on the new code.

**Lesson:** your error path sees your largest inputs on your worst days. Anything that grows with input size, including logs, reports, and retry buffers, must be streamed or bounded.

---

## 3. Queues and workers: throughput without starvation

Once chunks exist, they are processed by pools of worker threads pulling from queues. Three design decisions matter here.

### Bounded concurrency

Each worker process has a fixed-size thread pool. That bound is not just about CPU. Every worker opens database sessions, holds records in memory, and calls downstream services. An unbounded pool turns a burst of files into a burst of database load, which slows every worker, which lengthens processing, which lets more work pile up. A fixed bound turns a burst into a queue, which is much easier to reason about.

### Lanes

There are separate **normal** and **priority** queues, served by separate worker processes. A historical backfill (thirteen months of interval data for a new customer, say) should never sit in front of the routine overnight file that customers expect to see in the morning.

Separate lanes are a blunt but effective tool. Idle priority capacity cannot help the batch lane, so you pay for isolation with some efficiency. At this volume, isolation is usually worth it.

### Tenants share more than you think

Downstream of ingestion, the work that turns raw readings into analytics is also queue-driven, and queues are grouped: several utilities share one group. One day, a burst from one utility filled a shared queue, and another utility's work sat behind it **for more than 48 hours**. Nothing was lost. Nothing errored. Every component was healthy by its own measures.

The fix was to move the affected utility to a dedicated partition. The monitoring lesson is more general:

- **queue depth** tells you how much work is waiting;
- **message age** tells you how long a customer has been waiting.

Only the second maps to anything a customer experiences. An alarm on depth alone will fire during every healthy backfill and stay quiet during a slow starvation.

### Backlogs you can only purge

Years earlier, a shared downstream queue reached about **30 million messages**, and analytics were delayed for every customer for days. The recovery was to purge the queue and process new work to catch up. That worked. But a purge discards work, and it is only safe if you know how to rebuild what you threw away.

**Lesson:** before you ever need to purge a queue, know how you would replay it.

### Concurrency that does not scale linearly

Thread pools also interact in ways that only show up under load. One analysis of the file pickup layer found around 140 listener threads (one per utility and file type) feeding a task pool of just three threads. Adding listeners added contention, not throughput. Another path checked each utility's SFTP folder sequentially, file type by file type, on a fixed interval, so throughput was bounded by the number of utilities, not by the amount of work.

The proposed direction is role-based workers that can be scaled independently, a distributor that partitions files across machines, and idempotent processing with locking so several instances can safely compete for the same work.

**Lesson:** "add more machines" only helps if work can be partitioned and processed idempotently. Otherwise you scale contention.

---

## 4. Processing: every record is a small distributed transaction

Inside a chunk, each record goes through parsing, validation, a utility-specific transformation, and then the expensive part: **finding the customer, home and meter the reading belongs to**, which means reading from the database before writing to it.

That makes ingestion **read-heavy as well as write-heavy**. A million readings can mean a large number of customer lookups. Two consequences follow.

### Retries hold threads

Transient database errors are retried: up to five retries with exponential backoff starting at one second. Non-transient errors are not retried at all. That is a reasonable policy, but notice what it costs during an outage. The backoff happens on the worker thread. When the database is slow for everyone, many workers can be sleeping between retries at the same time, and the pool's effective capacity drops exactly when the backlog is growing.

After the last retry, the record is skipped and written to the error file. During one period of database read timeouts, that is what happened: records failed after all retries and were skipped, so customer enrollments and updates in those files were not applied. Years before that, a utility found missing enrollments from *its own* error report before the platform's monitoring flagged them.

**Lesson:** bounded retries need a destination after the last attempt that someone actually watches, and a way to replay from it.

### Caching to cut read amplification, and its sharp edge

To avoid hitting the database for every lookup, customer records are cached: an in-process cache in each JVM, backed by a shared cache across services, with a small invalidation channel so instances know when to drop stale entries.

That cache caused the strangest failure I've seen in this system.

A release added one field to a class that was stored in the shared cache. The cache used a compact binary serializer that writes fields **by position**, in alphabetical order, with no field names and no version. The cache key had no version either. The new field sorted fifth of twenty-three, so when new code read an entry written by old code, every field after the fourth was read from the wrong bytes.

Most corrupted entries failed immediately and were reloaded from the database. Some decoded "successfully" into objects with the wrong types in their fields, because the serializer sets fields without type checks. The crash came later, when code used one of those objects and the JVM threw an `IncompatibleClassChangeError`.

That is an `Error`, not an `Exception`. It passed straight through every `catch (Exception)` on the ingestion path. The worker threads had no uncaught-exception handler, so each death appeared only in the process's raw console output, never in the application log. Sixteen worker threads on one host died this way.

The fix plan had four parts: version the cache key; treat this class of error during a cache read as a cache miss and reload from the database; catch `Throwable` at the record and message boundaries; and attach an uncaught-exception handler that logs and reports thread deaths. The prevention is a test that fails when a cached class changes without a version bump.

**Lessons:** version anything you serialize into a shared store. Catch everything at the worker boundary. And treat "a unit of work that never finishes" as a failure, even if nothing reported failing.

---

## 5. Delivery: at-least-once, whether you like it or not

A worker deletes its queue message **only after success**. If the process crashes, or an exception escapes, the message becomes visible again after its visibility timeout and another worker picks it up. Messages that keep failing eventually move to a dead-letter queue.

That gives you **at-least-once** delivery. It does not give you exactly-once, and it has a consequence that is easy to miss: a chunk that fails at record 3,000 has already written records 1 to 2,999. On every retry, those records are written again.

The thread-death incident above made this concrete. The poisoned chunk was redelivered about every half hour. Each time, everything before the bad customer record was re-applied, and everything after it was never processed. From the outside, the chunk looked "in progress" forever.

```
attempt 1:  rec 1 … rec 2,999 ✔   rec 3,000 ✖ (thread dies)   rec 3,001 … never
attempt 2:  rec 1 … rec 2,999 ✔ (again)   rec 3,000 ✖          …
attempt N:  …
```

At-least-once delivery is only safe if writing the same record twice has the same effect as writing it once. That property lives in the storage layer.

---

## 6. Storage: idempotency, collisions, and two tiers

### The key is the design

Interval readings are stored with a partition key of **meter plus a fixed time bucket**, and the **reading timestamp** as the clustering key within it. Every write is an upsert.

```
partition:  (customer, home, gateway, meter, 30-day bucket)
row:        reading timestamp → value
```

Three things follow from that one choice:

- **Retries are harmless.** Writing the same reading twice leaves one row. This is what makes at-least-once delivery safe.
- **Partitions are bounded.** Partitioning by meter alone would let a partition grow forever. A fixed time bucket caps its size and matches the dominant query: *this meter, this time range*.
- **Collisions are silent.** If two *different* readings produce the same key, the second overwrites the first, and the database reports success.

### The opening example

Here is a synthetic version of how that last property bites. A partner sends two readings on the night the clocks go back:

| Source timestamp | Reading |
|---|---|
| `2026-11-01 01:30 −04:00` | 0.42 kWh |
| `2026-11-01 01:30 −05:00` | 0.57 kWh |

They are an hour apart. Keep the offset, convert to UTC correctly, and they get two keys and two rows. Lose the offset (say the partner sends local time only) and both become `01:30`, map to the same instant, and produce the same key. Two successful writes, one row.

The real version was slightly different and lasted longer. A partner sent local timestamps that stayed on standard time all year. The ingestion configuration interpreted them in a zone that observes daylight saving. For roughly eight months of every year, every reading was stored an hour early, and on the spring transition night, two readings landed on the same instant and one replaced the other. The partner noticed first, because customers' overnight electric-vehicle charging appeared to start an hour before their cheap overnight rate did.

You cannot fix this by giving up upserts: that would break retries. The defence moves elsewhere. Time rules become part of the onboarding contract, and anything that checks completeness has to look at *distinct keys in the destination*, not just counts of successful writes.

### Ordering by arrival is not ordering by meaning

Upserts give you "last writer wins". The question is *last by what?* Billing data shows why that matters. Corrected bills are applied in the order files arrive, not in the order of the billing periods they describe. Replaying an older file can reinstate an older version of a billing cycle. Last-writer-wins by arrival time is not the same as last-writer-wins by business time.

### Two tiers: hot data hot, history cheap

Time-series data has a clear shape: recent data is read and rewritten constantly; old data is read rarely and changes only during backfills and corrections. A recent redesign of raw-data storage follows that shape:

```
reading timestamp ≥ start of current 30-day bucket  →  database (fast writes and reads)
reading timestamp <  start of current 30-day bucket  →  object storage (cheap, durable)

read spanning both  →  query both, merge by last-updated stamp (newest write wins)
```

Before this, every ingest batch did a read-modify-write of a monthly file in object storage: one expensive write per batch, many times a day per meter. In the new design, recent data is absorbed by the database, and an archival job writes each closed bucket to object storage in one go. (While that job is being proven, recent data is also written to object storage as a safety net.)

The interesting part is the design that was **rejected**. The obvious rule is "route by age: anything newer than *now minus the retention period* goes to the database". It fails on re-ingestion. Because that cutoff moves with the clock, re-ingesting an older range can leave stale copies in the database that no read strategy can reconcile correctly. Routing by a fixed bucket boundary avoids that, and has a valuable side effect: **a historical backfill never touches the database at all**, so a thirteen-month backfill cannot cause a database capacity spike.

**Lesson:** test every storage design against re-ingestion, not just first ingestion. That is where most designs break.

---

## 7. Fan-out: one file, many downstream jobs

Ingesting readings is not the end. New data triggers downstream work (aggregations, disaggregation, bill analysis) for each affected customer. That fan-out is where a file's cost can multiply without anyone noticing.

During one thirteen-month backfill test, ingestion produced around **280,000 downstream messages** and kept producing them as the file was processed, enough to block other testing in that environment. A historical load is a single business event, but it was being treated as hundreds of thousands of small ones.

**Lesson:** trigger downstream work per customer per file, not per record, and give backfills a lane or a rate limit of their own.

### Dependencies between files

Some files depend on others. An enrollment file creates customers; a preference file sets their communication preferences. If the preference file is processed first, every record fails with *customer does not exist*.

There is an ordering gate for exactly this case, but it was evaluated *before* a long queue poll, not after a message arrived. Two files landing a second apart could slip past it. The preference records failed, the message was deleted as processed, and the preferences were never retried. This was a classic check-then-act problem across a wait.

The fix re-checks the gate after a message is received, and an out-of-order file is **deferred back to the queue** instead of failing. "Not yet" and "never" need different answers.

### What is the unit of rejection?

One more choice shapes every partner's experience: when part of a document is bad, what do you reject? A bill with twelve line items and two invalid ones is rejected as a whole. That sounds harsh (ten valid lines discarded) and it delayed one utility's launch. But it is deliberate: a partially ingested bill has the wrong total, and a wrong bill is worse than a missing one. The important thing is that the unit of rejection, whether row, document or file, is a decision someone made and documented, not an accident of where an exception happened to be caught.

---

## 8. Evidence: what "done" actually means

After all of that, someone asks: *did the file make it?*

The pipeline leaves a trail. Each chunk records milestones as it moves (received, read, transformed, ingested, sent for reporting) with counts at each step: lines read, records that failed transformation, records ingested, records that failed ingestion. Failed lines are stored and reported to the partner. Optionally, a separate audit step counts the records in the original file before ingestion starts.

That is a lot of evidence, and it still has limits worth stating precisely.

- **It is the pipeline's account of its own work.** "2 ingested, 0 failed" means two writes succeeded. It does not mean two rows exist. The opening example passes every count.
- **It arrives late.** The audit trail reaches the analytics store with a lag that can be many hours. A file with no audit rows is not necessarily a lost file; the evidence may not have arrived yet.
- **It cannot see silent stops.** A chunk whose worker thread died has started but never finished. That only shows up if "started but not finished after a reasonable time" is something you look for.
- **Monitoring is uneven.** At one point, queue-depth and throughput dashboards existed, while message age and end-to-end latency were still on the to-do list.

So I've stopped thinking of a file's outcome as *success* or *failure*. Every input record should end in one of four states:

1. **Confirmed:** evidence it was stored as intended.
2. **Rejected:** the pipeline refused it, and we can say why.
3. **Pending:** positive evidence it is still being processed.
4. **Unresolved:** none of the above.

"Unresolved" is not the same as "still in flight". Counts that do not add up are a finding, not a waiting state. A healthy pipeline is not one where the fourth bucket is empty because nobody looked; it is one where you can see its size, and it is small and explained.

---

## Back to the opening file

Two readings, two successful writes, one row. Walk it through the stages:

| Stage | What it can prove about the file |
|---|---|
| Arrival | The file was recognised and picked up |
| Chunking | Its records were split into chunks |
| Processing | Both records were parsed, validated and transformed |
| Delivery | The chunk's message was acknowledged after success |
| Storage | Two upserts succeeded |
| Evidence | 2 read, 2 ingested, 0 failed |

Every stage is green, and every stage is telling the truth. None of them, on its own, can say that both readings survived. Only a check against the destination, comparing distinct input keys with distinct stored keys, can do that.

That is what I have come to think "reliable" means at this scale. Not that nothing fails; at a terabyte a day, things fail every hour. It means that for every record you were given, you can say which of the four states it is in, and you know exactly which question each green light does and does not answer.
