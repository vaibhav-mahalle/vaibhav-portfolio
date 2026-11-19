---
title: "Every Record Accounted For"
subtitle: "Following one smart-meter file through a large ingestion pipeline, and what each green light really proves"
slug: every-record-accounted-for
date: 2026-11-20
publishAt: 2026-11-19T00:00:00+05:30
status: published
series: every-record-accounted-for
part: 0
tags: [data-engineering, distributed-systems, reliability, ingestion]
---

Here is a file with two meter readings in it. Both pass validation. Both are written successfully. The pipeline reports *2 records ingested, 0 failed*.

Storage holds one row.

Nothing crashed, nothing retried, no alert fired. Every component did exactly what it was designed to do. To understand how that happens, and why it is not simply a bug, you have to follow a file through the whole system.

The utility-analytics platform I work on [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters. In utility data generally, very little arrives as a tidy event stream. It arrives as files: interval readings, bills, customer enrollments, sent by utilities on their schedule, in their format, often many megabytes or gigabytes at a time.

This post follows one such file through a simplified, composite pipeline. Every failure below is a hypothetical or a pattern I have seen in systems like it, not a report on any one system. At each stage I'll describe what gets hard at volume, the design choice that handles it, and where that choice stops protecting you.

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

The rest of the series goes deeper: [chunking and streaming](/writing/chunking-and-streaming-large-files), [choosing the data store](/writing/choosing-the-right-data-store), [pipeline reliability](/writing/distributed-pipeline-reliability) and [end-to-end visibility](/writing/end-to-end-visibility).

---

## 1. Arrival: you do not control the sender

The first hard fact about file ingestion is that the producer is outside your system. You cannot deploy a fix to a utility's export job. You negotiate a contract (file names, delimiters, column positions, date formats, time zones, units) and then you discover where reality differs from the contract.

Some of those differences fail loudly: a missing column, an unparseable date. The dangerous ones fail quietly. If a file's *type* is inferred from a prefix in its name, a file with a plausible but wrong prefix is not rejected; it is simply never picked up for that type. Nothing errors, because from the pipeline's point of view nothing arrived.

Time is the worst offender, because a wrong time-zone assumption produces *valid* timestamps. I'll come back to this in the storage section; it is how the opening example happens.

**Lesson:** the contract with the producer is part of your system's design, even though you don't run the producer. Write it down, especially the time rules, and test it with ugly dates.

---

## 2. Chunking: making a large file into many small units of work

A single file can hold millions of rows for hundreds of thousands of customers. Processing it as one unit would mean one slow worker, one giant retry if anything fails, and one giant blast radius.

So the first real step is to split the file into **chunks**. Chunk size should be set per file type, because a row of 15-minute interval readings and a row of billing data cost very different amounts to process. Each chunk is an independent unit of work, with its own queue message, its own status (queued → processing → done or failed), its own file of rejected lines and its own retry.

A bad chunk does not block a good one, and a retry repeats a few thousand rows, not a whole file.

### Memory has to be bounded too

Chunking solves the *work* problem. It does not automatically solve the *memory* problem. A chunker that reads all of a file's records into memory and then slices them has peak memory proportional to file size: fine for typical files, dangerous for unusually large ones. Make streaming the default, not an option someone has to remember to turn on.

The less obvious place to look is **the error path**. Imagine that failed lines are collected into a report for the partner, encrypted and written out at the end, and that the report is built in memory. On a normal day the error count is small. On the day a partner sends a malformed file, the error count is proportional to the file size, and the process building the report runs out of memory, taking ingestion for *other* customers down with it. Streaming errors to disk as they are produced keeps memory flat however many lines fail. [Part 1](/writing/chunking-and-streaming-large-files) covers this in detail.

**Lesson:** your error path sees your largest inputs on your worst days. Anything that grows with input size, including logs, reports and retry buffers, must be streamed or bounded.

---

## 3. Queues and workers: throughput without starvation

Once chunks exist, pools of worker threads pull them from queues. Three design decisions matter here.

### Bounded concurrency

Give each worker process a fixed-size thread pool. That bound is not just about CPU. Every worker opens database sessions, holds records in memory and calls downstream services. An unbounded pool turns a burst of files into a burst of database load, which slows every worker, which lengthens processing, which lets more work pile up. A fixed bound turns a burst into a queue, which is much easier to reason about.

### Lanes

Separate **normal** and **priority** queues, served by separate worker processes, keep a historical backfill (thirteen months of interval data for a new customer, say) from sitting in front of the routine overnight file that customers expect to see in the morning.

Separate lanes are a blunt but effective tool. Idle priority capacity cannot help the batch lane, so you pay for isolation with some efficiency. At high volume, isolation is usually worth it.

### Tenants share more than you think

Suppose the downstream analytics work is also queue-driven, and several tenants share one queue group. One tenant's burst fills the shared queue, and another tenant's work waits behind it, while every component stays healthy by its own measures. The lesson is about monitoring:

- **queue depth** tells you how much work is waiting;
- **message age** tells you how long a customer has been waiting.

Only the second maps to anything a customer experiences. An alarm on depth alone will fire during every healthy backfill and stay quiet during a slow starvation.

A shared queue can also grow large enough that purging it is the only fast way out. A purge discards work, and it is only safe if you know how to rebuild what you threw away. **Before you ever need to purge a queue, know how you would replay it.**

### Concurrency that does not scale linearly

Thread pools interact in ways that only show up under load. Many listeners feeding a small shared task pool add contention, not throughput. Polling partner folders one at a time, file type by file type, ties throughput to the number of partners rather than the amount of work.

The usual way out is role-based workers that scale independently, a distributor that partitions files across machines, and idempotent processing with locks or claims so several instances can safely compete for the same work.

**Lesson:** "add more machines" only helps if work can be partitioned and processed idempotently. Otherwise you scale contention.

---

## 4. Processing: every record is a small distributed transaction

Inside a chunk, each record goes through parsing, validation, a partner-specific transformation, and then the expensive part: **finding the customer, home and meter the reading belongs to**, which means reading from the database before writing to it.

That makes ingestion **read-heavy as well as write-heavy**. A million readings can mean a large number of customer lookups. Two consequences follow.

### Retries hold threads

A common policy retries transient database errors a few times with exponential backoff and does not retry non-transient errors at all. That is reasonable, but notice what it costs when the database slows down. If the backoff happens on the worker thread, then when the database is slow for everyone, many workers sleep between retries at the same time, and the pool's effective capacity drops exactly when the backlog is growing.

After the last retry, the record is typically skipped and written to an error file. If that file is the only place the failure lands and nobody watches it, enrollments and updates can quietly fail to apply, and the first person to notice may be your customer, reading their own error report.

**Lesson:** bounded retries need a destination after the last attempt that someone actually watches, and a way to replay from it.

### Caching to cut read amplification, and its sharp edge

The standard way to avoid a database hit per lookup is a cache. Any cache that keeps serialized objects across releases has a well-documented failure mode with positional serializers, such as Kryo's default field serializer.

Such serializers write fields **by position**, with no names and no version. If a class gains a field and the cache key carries no version, new code reads old entries from the wrong bytes.

Most corrupted entries fail to decode and are reloaded from the database. Some decode "successfully". Serializers of this style write a class tag before an object-valued field and then set the field without a type check, so a misaligned read can place an object of the wrong class into a field. The crash comes later, when code calls an interface method on that object and the JVM throws an `IncompatibleClassChangeError`.

That is an `Error`, not an `Exception`, so `catch (Exception)` does not stop it, and a thread without an uncaught-exception handler can die without leaving an application-log entry.

**Lessons:** version the cache key, and add a test that fails when a cached class changes without a version bump. Treat a decode failure during a cache read as a miss. At the record and message boundaries, catch `LinkageError` as well as `Exception` (Part 3 explains why not all of `Throwable`), and install an uncaught-exception handler that reports thread deaths. Treat "a unit of work that never finishes" as a failure even if nothing reported failing.

---

## 5. Delivery: at-least-once, whether you like it or not

A worker should delete its queue message **only after success**. If the process crashes, or an exception escapes, the message becomes visible again after its visibility timeout and another worker picks it up. Messages that keep failing eventually move to a dead-letter queue.

That gives you **at-least-once** delivery. It does not give you exactly-once, and it has a consequence that is easy to miss: a chunk that fails at record 3,000 has already written records 1 to 2,999. On every retry, those records are written again.

The cache hypothetical above makes this concrete. The poisoned chunk is redelivered after every visibility timeout. Each time, everything before the bad customer record is re-applied, and everything after it is never processed. From the outside, the chunk looks "in progress" forever.

```
attempt 1:  rec 1 … rec 2,999 ✔   rec 3,000 ✖ (thread dies)   rec 3,001 … never
attempt 2:  rec 1 … rec 2,999 ✔ (again)   rec 3,000 ✖          …
attempt N:  …
```

At-least-once delivery is only safe if writing the same record twice has the same effect as writing it once. That property lives in the storage layer. [Part 3](/writing/distributed-pipeline-reliability) covers delivery and replay in more depth.

---

## 6. Storage: idempotency, collisions, and two tiers

### The key is the design

A common layout for interval readings partitions by **meter plus a fixed time bucket**, with the **reading timestamp** as the clustering key within it. Every write is an upsert.

```
partition:  (meter, time bucket)
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

You cannot fix this by giving up upserts, because that would break retries. The defence moves elsewhere. Time rules become part of the onboarding contract, and anything that checks completeness has to look at *distinct keys in the destination*, not just counts of successful writes.

### Ordering by arrival is not ordering by meaning

Upserts give you "last writer wins". The question is *last by what?* Billing data shows why that matters. If corrected bills are applied in the order files arrive, rather than the order of the billing periods they describe, replaying an older file can reinstate an older version of a billing cycle. Last-writer-wins by arrival time is not the same as last-writer-wins by business time.

### Two tiers: hot data hot, history cheap

Time-series data has a clear shape: recent data is read and rewritten constantly; old data is read rarely and changes only during backfills and corrections. One way to tier storage follows that shape:

```
reading timestamp ≥ start of current time bucket  →  database (fast writes and reads)
reading timestamp <  start of current time bucket  →  object storage (cheap, durable)

read spanning both  →  query both, merge by last-updated stamp (newest write wins)
```

Compare a design where every ingest batch does a read-modify-write of a per-meter history object in object storage: one expensive write per batch, many times a day per meter. With tiering, the database absorbs recent writes, and an archival job writes each closed bucket to object storage once.

The interesting decision is the routing rule. The obvious one is "route by age: anything newer than *now minus the retention period* goes to the database". Its weakness shows on re-ingestion: because the cutoff moves with the clock, the tier that owns a timestamp changes while data for it may still arrive. A correction written to the database just before the cutoff passes it can expire, or miss an archival pass that already ran, and merging by last-updated stamp only helps while both copies exist. A fixed bucket boundary makes each bucket either open or closed, with a valuable side effect: **a historical backfill never touches the database at all**, so a thirteen-month backfill cannot cause a database capacity spike. [Part 2](/writing/choosing-the-right-data-store) goes further into the storage choices.

**Lesson:** test every storage design against re-ingestion, not just first ingestion. That is where most designs break.

---

## 7. Fan-out: one file, many downstream jobs

Ingesting readings is not the end. New data triggers downstream work (aggregations, derived analytics, bill analysis) for each affected customer. That fan-out is where a file's cost can multiply without anyone noticing.

If downstream work is triggered per record, a single historical backfill can easily fan out into hundreds of thousands of downstream messages, so one business event is treated as hundreds of thousands of small ones.

**Lesson:** trigger downstream work per customer per file, not per record, and give backfills a lane or a rate limit of their own.

### Dependencies between files

Some files depend on others. An enrollment file creates customers; a preference file sets their communication preferences. If the preference file is processed first, every record fails with *customer does not exist*.

An ordering check is the obvious answer, and where you evaluate it matters. Suppose it runs *before* a long queue poll rather than after a message arrives. Two files landing a second apart can slip past it; the preference records fail, the message is deleted as processed, and the preferences are never retried. That is a classic check-then-act problem across a wait.

The rule: re-check ordering preconditions after the message is received, and **defer an out-of-order file back to the queue** instead of failing it. A missing customer that will exist in a minute is a retry, not a rejection.

### What is the unit of rejection?

One more choice shapes every partner's experience: when part of a document is bad, what do you reject? Suppose a bill with twelve line items and two invalid ones is rejected as a whole. That sounds harsh (ten valid lines discarded), but it can be the right call: a partially ingested bill has the wrong total, and a wrong bill is worse than a missing one. What matters is that the unit of rejection, whether row, document or file, is a decision someone made and documented, not an accident of where an exception happened to be caught.

---

## 8. Evidence: what "done" actually means

After all of that, someone asks: *did the file make it?*

A pipeline like this should leave a trail. Each chunk records milestones as it moves (for example: arrived, split, processed, stored, reported) with counts at each step: lines read, records that failed transformation, records ingested, records that failed ingestion. Failed lines are stored and reported to the partner. A separate audit step can count the records in the original file before ingestion starts.

That is a lot of evidence, and it still has limits worth stating precisely.

- **It is the pipeline's account of its own work.** "2 ingested, 0 failed" means two writes succeeded. It does not mean two rows exist. The opening example passes every count.
- **It can arrive late.** If audit events reach an analytics store through a batch or streaming loader, the lag can be hours. A file with no audit rows is not necessarily a lost file; the evidence may not have arrived yet.
- **It cannot see silent stops.** A chunk whose worker thread died has started but never finished. That only shows up if "started but not finished after a reasonable time" is something you look for.
- **Monitoring tends to be uneven.** Many teams build depth and throughput dashboards before message-age and end-to-end latency ones.

So I've stopped thinking of a file's outcome as *success* or *failure*. Every input record should end in one of four states:

1. **Confirmed:** evidence it was stored as intended.
2. **Rejected:** the pipeline refused it, and you can say why.
3. **Pending:** positive evidence it is still being processed.
4. **Unresolved:** none of the above.

"Unresolved" is not the same as "still in flight". Counts that do not add up are a finding, not a waiting state. A healthy pipeline is not one where the fourth bucket is empty because nobody looked; it is one where you can see its size, and it is small and explained. [Part 4](/writing/end-to-end-visibility) is about building that view.

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

## A checklist for your own pipeline

- Unknown or misnamed files land somewhere visible.
- Time-zone rules are in the partner contract and tested on transition nights.
- Chunking and error reports stream; nothing that grows with input is held in memory.
- Worker pools are bounded; backfills get their own lane or rate limit.
- Alarms fire on message age, not only queue depth.
- Every queue you might purge has a replay path.
- Workers catch `LinkageError` as well as `Exception` at the boundary, and report thread deaths.
- Anything serialized into a shared store carries a version.
- Completeness checks compare distinct keys in the destination.
- Out-of-order files are deferred, not failed.
- The "unresolved" count is visible.

In my view, that is what "reliable" means at this scale. Things will fail; reliability is being able to say, for every record you were given, which of the four states it is in, and knowing exactly which question each green light does and does not answer.

*Views are my own. Examples are simplified or made up and do not describe any specific employer or customer system.*
