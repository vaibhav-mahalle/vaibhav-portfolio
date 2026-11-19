---
title: "Every Record Accounted For"
subtitle: "Lessons from ingesting a terabyte of smart-meter data a day"
slug: every-record-accounted-for
date: 2026-11-20
status: published
tags: [data-engineering, distributed-systems, reliability, ingestion]
---

The utility-analytics platform I work on publicly reports processing about a terabyte of data a day, from tens of millions of smart meters. Most of that data does not arrive as a neat event stream. It arrives as files: interval readings, bills and customer enrollments, sent by utilities in batches, on their schedule and in their format.

When people talk about pipelines at this scale, they usually talk about throughput. Throughput matters. But the failures that hurt us most were not slow ones. They were quiet ones. A worker thread died and logged nothing where anyone looked. Two readings collided and one silently replaced the other. One customer's traffic delayed another customer's data by two days, and no error was raised anywhere.

This post is about the idea that changed how I think about these systems:

> At scale, reliability is not the absence of errors. It is the ability to say what happened to every record: stored, rejected, or still in flight.

I'll walk through how a large file moves through a pipeline like ours, the design choices that make it survivable, and the failure modes that taught us where "no errors" was lying.

---

## Why files are harder than events

An event is small, has one owner, and fails alone. A file is a batch of state. A single file can hold millions of rows for hundreds of thousands of customers, and it fails in pieces: row 40,112 has a bad date, row 900,331 refers to a meter that does not exist yet, and the other 999,000 rows are fine.

You also do not control the sender. Partners re-send files, send corrections weeks later, send two dependent files a second apart, and occasionally send an empty file next to a real one. So the pipeline has to assume three things from the start:

1. **Every file will be processed more than once.**
2. **Files will arrive out of order.**
3. **Some rows in every file will be wrong.**

Everything below follows from those assumptions.

---

## The shape of the pipeline

```
partner file (SFTP / object storage)
   │  pick up, decrypt, split into chunks
   ▼
chunks in internal storage ──event──► queue (normal / priority)
   │                                     │
   │  count records before ingesting     │  bounded worker pools
   ▼                                     ▼
 audit trail ◄── milestones ── parse → validate → transform → write
                                         ├─ time-series store (recent data)
                                         ├─ object storage (history, failed lines)
                                         └─ relational DB (billing cycles)
                                         │
                                         ├─ per-chunk status ledger
                                         ├─ downstream fan-out (analytics jobs)
                                         └─ completion event ─► partner error report
```

A few things are worth pointing out.

**Files are split into chunks before any processing.** Chunk size is configured per file type, because a row of interval readings and a row of billing data cost very different amounts to process. Each chunk becomes its own unit of work with its own queue message, its own status and its own error file. A bad chunk does not block a good one, and a retry repeats one chunk, not a whole multi-gigabyte file.

**Records are counted before ingestion starts.** A separate audit step reads the incoming file and records how many records it contains, independently of the main pipeline. That number is the anchor for everything else: if you do not know how many records arrived, you can never prove how many were stored.

**Interactive work and batch work use different lanes.** There are separate normal and priority queues, served by separate worker processes. A historical backfill should never sit in front of a customer who is waiting for their data to appear.

**Every chunk walks through explicit states.** Chunked, processing, lines-failed, processed, archived, reported. Failed lines are not just logged; they are written to storage, keyed by file and chunk, so they can be inspected and replayed, and a report goes back to the partner.

---

## Decision 1: Make re-runs boring

If every file will be processed more than once, the most important property of the write path is that processing the same data twice gives the same result.

For interval readings, the data is keyed by **meter plus a fixed time bucket** for the partition, with the **reading timestamp** inside it. Every write is an upsert. Re-ingesting a file overwrites the same rows instead of creating duplicates.

This one choice carries more weight than it looks. Queue messages are acknowledged **only after success**: a crash or exception means the message comes back and the chunk runs again. In practice that means rows *before* the failure point are written again on every retry. That is only safe because the writes are idempotent. **At-least-once delivery is only safe with idempotent writes.**

The time bucket matters too. Partitioning by meter alone would let a partition grow forever. Bucketing by a fixed window bounds partition size and matches the dominant read pattern: "this meter, this time range".

### The sharp edge of upserts

Upserts give you idempotency, but they also give you a way to lose data with no error.

One partner sent local timestamps that stayed on standard time all year. The ingestion configuration interpreted them in a time zone that observes daylight saving. For eight months of every year, every reading was stored an hour early. On the night the clocks changed, two different local times mapped to the same instant, so they produced the same key, and one reading silently replaced the other.

Nothing threw. The database did exactly what it was asked. The partner noticed first, because a customer's electric-vehicle charging appeared to start an hour before their cheap overnight rate began.

The lesson I took away: **when your key is a timestamp, the time-zone contract is part of your data model.** It belongs in onboarding, written down and tested with a daylight-saving date, not left to a default.

---

## Decision 2: Keep hot data hot and history cheap

Time-series data has a clear access pattern: recent data is read and rewritten constantly; old data is read rarely and almost never changes, except during backfills and corrections.

A recent redesign of our raw-data storage follows that pattern:

- Readings in the **current time bucket** go to the database, which handles frequent small writes and fast reads.
- Readings in **closed buckets** go straight to object storage, which is cheap and durable.
- A read that crosses the boundary queries both and merges by a last-updated stamp, so the newest write wins.

The previous design wrote every ingest batch into object storage as a read-modify-write of a monthly file, which is expensive and slow when files arrive many times a day.

The useful part of this story is the design that was **rejected**. The obvious approach was to route by age: anything newer than "now minus the retention period" goes to the database. It fails on re-ingestion. Because the cutoff moves forward with time, re-ingesting an older range leaves stale copies in the database that no read strategy can resolve correctly. Routing by a fixed bucket boundary avoids the problem, and gives a nice side effect: **a historical backfill never touches the database at all**, so it cannot cause a capacity spike.

If you take one thing from this section: **test every storage design against re-ingestion, not just first ingestion.** That is where most designs break.

---

## Decision 3: Memory must not grow with the input

At this volume, anything that scales with the size of the input will eventually run out of memory.

We learned this from error handling, which is the last place most people look. The component that builds the partner's error report used to collect all failed lines in memory before encrypting them and writing them out. On a normal day that was fine. On a day when a partner sent a malformed file, the number of errors was proportional to the file size, and the process ran out of memory, taking ingestion for other customers down with it.

The fix was to stream errors to disk in chunks as they occur. In testing with a 1 GB heap, a file with about a million bad lines crashed the old code and ran without trouble on the new code.

The general rule: **your error path will see your largest inputs on your worst days.** Design it for that, not for the happy path.

---

## The failures that did not raise an error

These are the incidents I think about most, because each one looked healthy from the usual dashboards.

### A worker that died without a word

A release added one field to a class that was cached, in a compact binary format, in a cache shared between services. The format stored fields by position, with no names and no version, and the cache key had no version either. When new code read entries written by old code, fields shifted by one. Some objects decoded "successfully" into nonsense, and later code that used them threw a JVM `Error`.

`Error` is not `Exception`. It passed straight through every `catch (Exception)` on the ingestion path. The worker threads had no uncaught-exception handler, so the death appeared only in the process's raw output, not in the application log. The queue message was never acknowledged, so the chunk came back every half hour and failed at the same record every time. Records before that point were rewritten on every retry; records after it were never processed.

Three lessons:

- **Catch everything at the worker boundary.** Log it, count it, and mark the unit of work failed.
- **Version anything you serialize into a shared cache.** A schema change should change the key.
- **A chunk that never finishes is a failure, even if nothing failed.** Track "started but not completed" as a state.

### One tenant delaying another

Two customers shared one processing queue. One sent a large burst; the other's messages sat behind it for more than 48 hours. Nothing was lost and nothing errored. The only signal was that data was late.

The fix was a dedicated partition. The lesson is about monitoring: **queue depth tells you how much work is waiting; message age tells you how long a customer has been waiting.** Only the second one maps to a user's experience.

### A backlog that could only be purged

Years earlier, a shared downstream queue reached tens of millions of messages, and analytics were delayed for every customer for days. The recovery was to purge the queue and catch up on new work. That worked, but a purge is only safe if you can rebuild what you threw away. **Before you need to purge a queue, know how you would replay it.**

### Order without a guarantee

Two related files, one creating customers and one setting their preferences, regularly arrived about a second apart. There was an ordering check, but it ran before a long queue poll, not after a message arrived. Files that landed during the poll skipped the check, the preference rows failed with "customer does not exist", and the message was deleted, so they were never retried.

The general pattern is check-then-act across a wait. **If a dependency is not ready, defer the work back to the queue instead of failing it.** Failing is the wrong answer to "not yet".

---

## What "accounted for" looks like in practice

My own part of this work sits at the edges of the pipeline: getting a new utility's data in correctly before go-live, and proving afterwards that it arrived. Two tools came out of that.

**A preflight check, before upload.** It checks a file against the configuration it will be ingested with: naming, format, the fields that configuration expects. Most ingestion failures I have seen were not bugs in the pipeline; they were a mismatch between what the partner sent and what we were told they would send. That is far cheaper to find before the file enters a system that writes to five stores.

**A post-upload audit, after ingestion.** For a given file it reports each pipeline step, record and failure counts, timestamps, and queue depth. It turns "did it work?" into a balance:

```
records counted at intake = records stored + records rejected + records still in flight
```

If that equation does not balance, the file is not done, however clean the logs look.

Neither tool is clever. Their value is that they replace a feeling ("no alerts fired") with an answer ("these rows were rejected, and here is why").

---

## A checklist for high-volume file ingestion

If I were building one of these pipelines from scratch, this is the list I would start with:

1. **Count records at intake**, independently of processing.
2. **Chunk files** and give each chunk its own status, error file and retry.
3. **Make writes idempotent** with deterministic keys, and treat at-least-once delivery as a given.
4. **Write the time-zone contract down** and test it with a daylight-saving date.
5. **Stream everything that scales with input**, including error reports.
6. **Catch everything at the worker boundary** and report thread deaths.
7. **Version serialized cache entries.**
8. **Separate lanes**: priority versus batch, and per tenant where volumes differ.
9. **Alarm on message age**, not only on errors and queue depth.
10. **Have a replay path** for anything that exhausts its retries or gets purged.
11. **Reconcile**: intake = stored + rejected + in flight, per file.

---

## Closing

It is easy to build a pipeline that is fast on a good day. The harder and more valuable work is building one that can tell you, on a bad day, exactly what it did with every record it was given.

The incidents in this post were all fixed. What stayed with me is how few of them announced themselves. In a system that handles a terabyte a day, silence is not a health signal. Accounting is.
