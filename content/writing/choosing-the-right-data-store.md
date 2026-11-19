---
title: "Choosing the Right Data Store for Billions of Meter Readings"
subtitle: "Start from access patterns, design the key, then find out what each store will hide from you"
slug: choosing-the-right-data-store
date: 2026-11-26
series: every-record-accounted-for
part: 2
status: published
tags: [data-engineering, distributed-systems, cassandra, storage, time-series, reliability]
---

Four hourly meter readings go into a database. All four writes succeed. Storage now holds three keys, and two of them are an hour early. Nothing in the store will ever tell you, because from its point of view nothing went wrong.

The utility-analytics platform I work on [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters. Much of data like that is interval readings: one number per meter every fifteen minutes or every hour, arriving in files, often late, sometimes twice, occasionally wrong.

This post is a design exercise for a pipeline of that general shape. The tables, numbers and failure stories below are my own simplified examples, not a description of any production system. At this kind of volume the useful question is not "which database is best?" It is **which store for which access pattern, and what does each store do quietly when the data stops behaving?** Every common choice is reasonable, and each one has a failure mode that reports success.

---

## 1. Access patterns come first

Before choosing a store, write down how the data is written and read:

| Access pattern | Shape | What matters | Store category |
|---|---|---|---|
| Ingest interval readings | Huge volume of small writes, mostly recent | Write throughput, safe retries | Wide-column database |
| One meter over a time range | Lookup by meter, range scan on time | Locality | Wide-column (recent), object storage (history) |
| Corrections, re-deliveries | Rewrite existing readings | Overwrite without duplicates | Same, via upsert |
| Historical backfill | Months of data for many meters | Must not starve live traffic | Object storage |
| Customer and meter lookups | Key lookups on every ingested record | Low-latency reads under write load | Key-value store plus a cache |
| Billing cycles, enrollments, profiles | Inserts, insert-or-update, small transactions | Constraints, transactions | Relational database |
| Audit and analytics events | Append-only, queried in aggregate | Scans, joins, SQL | Warehouse |
| Failed lines, raw history | Large, rarely read, durable | Cost per byte | Object storage |
| Coordination | Mutual exclusion across workers | Short-lived locks | A distributed lock service |

The dominant pattern is "write a small value keyed by meter and time, then read a contiguous range for one meter". Almost nothing on the raw-reading path needs joins, ad hoc filters or multi-row transactions. That decides the main store.

---

## 2. Why a wide-column store fits, and what it costs

I'll use Cassandra's behaviour as the reference, since it is the best-known store of this kind. Checked against the access patterns above, the choice holds up, with costs that drive the rest of this post.

**What it gives this workload:**

- **The key matches the query.** A partition per meter and time bucket, sorted by timestamp, turns "this meter, this range" into a read of a few contiguous partitions.
- **Cheap, evenly spread writes.** Writes go to a log and memory table and merge later. Millions of meters as partition keys spread load across the cluster.
- **Every insert is an upsert.** Writing an existing key overwrites it, with no read and no error. That is what makes at-least-once delivery safe.
- **Data can expire on its own.** Row TTLs plus time-window compaction let old data drop out in whole files.

**What it costs:**

- **No joins, no ad hoc queries.** One table per query. "All meters where…" belongs elsewhere.
- **Partition sizing is your job.** Get the bucket wrong and partitions grow without bound.
- **Deletes are writes.** A tombstone is written and compacted away later.
- **TTL counts from the write, not from the data.** Section 7 shows this one fact shaping a whole tiering design.
- **Capacity problems become correctness problems.** When the database is slow, workers retry, exhaust their retries and fail records. Capacity planning is part of data correctness, which [Part 3](/writing/distributed-pipeline-reliability) covers from the retry side.

---

## 3. Key design: bucket the time, bound the partition

A key shape that fits the dominant pattern:

```
partition key:   (meter, time bucket)
clustering key:  reading timestamp
```

In practice the partition key usually also carries whatever tenant or account identifiers your lookups need. The part that matters here is the bucket. For this exercise I'll use a fixed 30-day window rather than a calendar month:

```
bucket = epoch_seconds / 2,592,000      (integer division; 30 × 86,400)
SYNTHETIC: 1,700,000,000 / 2,592,000 = 655
```

No calendar, no time zone, no month lengths. Every service computes the same number from the same timestamp. A calendar-month text column looks friendlier, but deriving a month string means parsing a date in some time zone, and an integer from epoch seconds cannot depend on one.

### Partition-sizing arithmetic

Partitioning by meter alone would put every reading a meter ever produces into one partition. The bucket caps it:

| Interval | Readings per day | Rows per 30-day partition |
|---|---|---|
| 60 minutes | 24 | 720 |
| 15 minutes | 96 | 2,880 |

The cap does not depend on how long the customer stays. A year of one meter's data is about 13 partitions; a day is one.

You can go further and cluster by **day within the bucket** (0–29), each row holding a map of that day's readings. A partition then has at most 30 rows. For illustration, assume about 100 bytes per reading as text: a 15-minute day-row is about 9.6 KB, and a full partition about 30 × 9.6 KB ≈ 290 KB.

One more detail that bites at runtime rather than at schema time: **match column types to what the driver binds.** Declare a column as a small integer while the application binds a regular integer, and the Java driver fails with a codec error on the first write.

The cost of bucketing: a query spanning N buckets is N partition reads. Run them in parallel, or accept latency that grows with the range.

**Lesson:** size partitions with arithmetic before writing the schema, and choose a bucket every service can compute without a time zone.

---

## 4. Upserts: retries become safe, collisions become silent

Suppose a worker deletes its queue message only after success, so a crash means the chunk is processed again. The key makes that safe:

```
attempt 1: (meter M, bucket 655, ts T) = 0.42   → row created
attempt 2: (meter M, bucket 655, ts T) = 0.42   → same row, same value
```

The same property means the database cannot tell a retry from a collision. If two **different** readings produce one key, the second overwrites the first and both writes succeed. Duplicates can vanish even earlier: a write path that groups a batch by timestamp in memory collapses two readings with one timestamp to one, last wins, with nothing counted.

### The spring-forward collision

A failure pattern common in interval data: a sender emits local timestamps that stay on standard time all year, and the pipeline parses them in a zone that observes daylight saving. From the transition on, every reading in the daylight-saving months is stored an hour early. On the spring-forward night, 02:00 does not exist in the parsing zone, so two readings map to one instant and one overwrites the other.

A synthetic version, in a zone moving from UTC−5 to UTC−4 at 02:00 local:

| Sender label (standard time) | True instant (UTC) | Parsed in DST-aware zone as | Stored key (UTC) | Outcome |
|---|---|---|---|---|
| 01:00 | 06:00 | 01:00 −05:00 | 06:00 | correct |
| 02:00 | 07:00 | non-existent; lenient parser moves it to 03:00 −04:00 | 07:00 | overwritten |
| 03:00 | 08:00 | 03:00 −04:00 | 07:00 | overwrites 02:00 |
| 04:00 | 09:00 | 04:00 −04:00 | 08:00 | an hour early |

Four successful writes leave three keys and a chart that still looks plausible. (Parsers differ on non-existent local times; "moves forward" is common lenient behaviour, not a universal rule.)

The same trap comes back in other forms: a configuration that pins a fixed standard-time offset where a DST-aware zone was meant, or a format that repeats local-time labels in the fall-back hour while the stored key drops the offset. Idempotency has to be re-earned for every new format.

### What actually defends you

Giving up upserts would make retries create duplicates. The defences move to the edges:

- **Time rules in the onboarding contract:** zone, offset, interval start or end.
- **Keep the offset or original string** next to the epoch value, so collisions can be audited.
- **Count distinct keys, not successful writes.** Compare distinct (meter, timestamp) pairs after parsing with distinct keys stored for that range. A shortfall is a collision. [Part 4](/writing/end-to-end-visibility) builds this into a reconciliation check.
- **Check counts per local day.** A DST zone has 23-, 24- and 25-hour days. The wrong count is a time-zone bug even when nothing collided.

**Lesson:** the property that makes retries safe also hides collisions. Detection has to live outside the database, because the database will never complain.

---

## 5. "Last writer wins" needs a definition of "last"

If corrected records are applied in the order files are processed, rather than the order of the periods they describe, replaying an older file can reinstate older data:

```
SYNTHETIC
file A (arrives Monday):   cycle Mar, corrected amount  → stored
file B (arrives Tuesday):  cycle Mar, original amount   → overwrites A
```

A tiered design like the one in section 7 can stamp each record with a last-updated time and resolve disagreements between stores by it. That is the right tool for making two copies of a reading agree. But the stamp measures **when the pipeline wrote the record**: arrival order with better bookkeeping, not business order. If the newest write carries the oldest truth, the stamp prefers it.

When business order matters, the record must carry it (a statement date, a revision number, a source sequence), and something must compare before keeping a value: the write, at the cost of a read, or the reader.

**Lesson:** for every last-writer-wins rule, write down which clock defines "last", and check it is the one the business cares about.

---

## 6. The other stores, and why they are not the main database

**Relational, where constraints beat volume.** Billing cycles, enrollments and per-home profiles are few compared with readings, they relate to each other, and partial state is worse than none. All-or-nothing across a customer's profile rows is a guarantee a wide-column store does not give across partitions, and a unique constraint turns a would-be silent duplicate into an error.

**A warehouse for questions nobody planned.** "How many chunks for this sender failed last Tuesday?" needs scans and group-bys no partition key anticipated. The cost is latency: events delivered through a buffered stream can land minutes or hours after the fact, a problem [Part 4](/writing/end-to-end-visibility) spends a whole section on. Anything needing a fast answer about one chunk should not depend on it.

**Object storage for history and leftovers.** It is the cheapest durable store per byte and good at whole-object reads and writes. It cannot append one reading; it can only write the whole object again, and every write is billed. That is the next section's problem.

**A lock service for coordination.** When several writers may touch the same object, a short-lived distributed lock serialises them. It matters below.

---

## 7. A tiering exercise: hot database, cold object storage

### The problem: a read-modify-write per batch

Suppose raw readings live **only in object storage**, one object per meter per 30-day bucket. Every ingest batch reads the object, merges new readings in, and writes the whole object back: many full-object writes per meter per day.

```
SYNTHETIC: one meter, 24 ingest batches in a day
object storage only:  24 × (GET bucket object + PUT whole bucket object)
tiered:               24 small database upserts now, 1 PUT when the bucket closes
```

The goal of tiering is to collapse those writes into one archival write per bucket and to serve recent reads from the database.

### The layout and routing

Give the database table the same partition key and bucket as the object-storage key, so both stores split time identically, and cluster by day as in section 3. For this exercise, set a 60-day TTL with time-window compaction (the archival window below explains the 60).

```
stamp every record: last_updated = now

routing on:
    ts ≥ start of current bucket → database
    ts <  start of current bucket → object storage only

read:
    range inside current bucket  → database only
    range starts earlier         → database AND object storage, whole range;
                                   merge by timestamp, higher last_updated wins
    routing setting unavailable  → object storage only
```

That last line deserves a pause. If the routing lookup fails, recent readings that exist only in the database become invisible. Once only one store holds recent data, a failed lookup is a read that returns partial data without error. A fallback has to return complete data or an error, never just less data.

### The tempting design: route by age

The obvious rule: write a reading to the database if it is newer than *now minus TTL*, otherwise to object storage, and read with the same cutoff. My own worked example, with a 50-day cutoff:

| Date | Event | Cutoff (now − 50 d) | Object storage gets | Database gets |
|---|---|---|---|---|
| May 20 | First ingest, Jan 1 – May 20 | Mar 31 | Jan 1 – Mar 30 | Mar 31 – May 20 |
| May 30 | Re-ingest with corrections, Jan 1 – May 30 | Apr 10 | Jan 1 – Apr 9 | Apr 10 – May 30 |

After May 30, March 31 to April 9 is **fresh in object storage and stale in the database**. The second run never wrote those days to the database, so the May 20 copy is never overwritten. Every read strategy now fails:

| Read strategy | Result |
|---|---|
| Database first | Serves the stale Mar 31 – Apr 9 copy |
| Age-aware read on June 4 (cutoff Apr 15) | Object storage has data only to Apr 9, and the read takes the database only from Apr 15. **Apr 10–14 vanish.** |

The obvious patch, "also rewrite the overlap into the database", fails too. Rewriting March data in late May resets its TTL, so old data lives as long as new data. Re-ingest every few weeks and old readings stay in the hot tier indefinitely.

### The root constraint: TTL counts from the write

Every failure above comes from one fact: **the database's TTL is based on write time, not on the reading's timestamp.** Route by the reading's age while expiry runs on the write's age, and the two clocks drift apart on every re-ingestion. No merge rule fixes that, because the stores disagree about which data should exist at all.

So the cutoff must not move with the clock. Use the **start of the current bucket**, which moves once every 30 days. The same story with a fixed boundary (the bucket grid puts one at 2026-05-07 00:00 UTC):

| Date | Event | Boundary | Object storage gets | Database gets |
|---|---|---|---|---|
| May 20 | First ingest, Jan 1 – May 20 | May 7 | Jan 1 – May 6 | May 7 – May 20 |
| May 30 | Re-ingest, Jan 1 – May 30 | May 7 | Jan 1 – May 6 | May 7 – May 30 (overwrites May 7–20) |

Same input, same split, whenever it runs. Older readings never enter the database, so they cannot leave stale pockets there. When the boundary moves, the closed bucket stays in the database until it expires, and reads across it merge both stores by last-updated.

A side effect matters as much: **a historical backfill never touches the database.** Months of history for many meters go straight to object storage instead of competing with live writes for database capacity.

### Why 60 days: the archival window

A bucket's earliest readings can be written on its first day. With a 60-day TTL they expire 30 days after the bucket closes, so an archival job has about 30 days to copy the closed bucket to object storage. With a 40-day TTL it would have about 10. Rows rewritten by a correction get a fresh TTL and live longer, so the deadline is set by the earliest write that was never rewritten.

```
day 0 ─────────── day 30 ─────────────────── day 60
│ bucket open     │ bucket closed            │ earliest rows expire
│ (writes)        │ ←── archival window ──→  │
```

That makes archival the critical dependency. If TTL fires first, the data is gone permanently, so **archival lag alerting is mandatory**. The archival job itself needs to:

- **Merge by last-updated, never blind overwrite.** A correction to a closed bucket goes straight to object storage, which may already be newer than the database copy.
- **Take the same per-object lock** as other writers, and **fail closed**.
- **Be idempotent** and safe against concurrent deletes.

One more trap: deleting an archived partition does not free disk early. Under time-window compaction the tombstone lands in a later window, so space returns only when data expires. Plan for about two full buckets.

### Writes: parallel upserts, not batches

Group readings by day, and make each day one update that merges entries into that day's map, with no read first. Re-ingestion then replaces individual readings without wiping the rest of the day.

Send the day statements asynchronously, one future each, then join. Don't wrap them in a database batch. A logged batch writes a batch log, and any multi-partition batch makes one coordinator fan out, which adds overhead and buys nothing here, because the writes are independent and idempotent. If one fails, retry the unit; the successful days are rewritten harmlessly.

```java
// Illustrative, written for this post
List<CompletableFuture<?>> writes = new ArrayList<>();
for (DayRow day : rowsByDay) {
    // UPDATE ... SET readings = readings + :entries, last_updated = :now WHERE <key> AND day = :d
    writes.add(session.executeAsync(mergeDay(day)).toCompletableFuture());
}
CompletableFuture.allOf(writes.toArray(new CompletableFuture[0])).join(); // any failure → retry the unit
```

### The write that must not fail silently

Object-storage writes are a common place for failures to be swallowed. A writer may retry, but after the last retry it must return or throw the failure, never log and return normally. Otherwise a reading that was never stored counts as ingested: the [overview's](/writing/every-record-accounted-for) "2 ingested, 0 failed" from a different cause. Any merge on that path must also compare last-updated stamps the same way the read path does.

**Lesson:** retrying inside a write is fine; deciding inside a write that failure doesn't matter is not. Return the failure and let the caller retry, record or stop. That is why "fail closed" is an archival requirement.

---

## 8. Capacity: show the method, find the sensitive input

The inputs below are **made up for illustration**. The method and the sensitivity are the point.

| Quantity | Basis | Estimate |
|---|---|---|
| Meters in scope | assumed | 10 million |
| Readings per day | 15-minute interval | 96 |
| Size per reading | assumed, text | ~100 bytes |
| Day-rows per bucket | 10M × 30 | 300 million |
| Readings per bucket | 300M × 96 | ~28.8 billion |
| Size per bucket | 28.8B × 100 B, uncompressed | ~2.9 TB |
| Steady state | ~2 buckets, replication factor 3, 3–5× compression | ~3.5–5.8 TB |
| With compaction headroom | assumed +30% | ~4.5–7.5 TB |
| Average writes | 10M day-rows a day ÷ 86,400 s | ~116/s |
| Peak writes | assumed 4× average | ~460/s |

Steady state is about two buckets because of the TTL and compaction behaviour above: one open, one closed and waiting to expire. The write rate assumes one day-row write per meter per day; if a meter's day arrives in several batches, multiply by the batch count.

The most sensitive input is the row format. A packed binary reading (a small time offset and a numeric value) might take 10–20 bytes against the 100 assumed for text, so **serialization alone can move storage by 5–10×**, more than the whole compression range. Settle it with measurements before the schema ships, because changing it later means rewriting every row.

---

## A checklist for choosing a store

1. **Patterns.** What are the write and read shapes, and which dominates? Does anything need joins, ad hoc filters or multi-row transactions?
2. **Partitions.** Show the arithmetic for the largest partition. Can every service compute the bucket without a time zone?
3. **Retries.** Is every write idempotent under at-least-once delivery?
4. **Collisions.** Which distinct inputs could share a key, and how will you detect it when the store reports success?
5. **Ordering.** Which clock defines "last"? Is it the business clock?
6. **Expiry.** Does TTL count from the write or the data? What does re-ingestion do to it?
7. **Re-ingestion.** Replay last quarter through the design. Does it leave stale copies anywhere?
8. **Boundaries.** Does the tier boundary move with the clock or in fixed steps? Do reads and writes share it?
9. **Deadlines.** If a background job must finish before data expires, how long does it have, and what alerts when it lags?
10. **Failures and fallbacks.** Can every write tell its caller it failed? When a lookup fails, does the fallback return complete data, or just data?
11. **Capacity.** Which estimate inputs are measured, which are guesses, and which single choice moves the answer most?

Data at this volume arrives late, twice, out of order and in the wrong time zone every day. Choose stores by what they do when that happens.

*Views are my own. Examples are simplified or made up and do not describe any specific employer or customer system.*
