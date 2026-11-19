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

The utility-analytics platform I work on [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters. A large share of it is interval readings: one number per meter every fifteen minutes or every hour, arriving in files, often late, sometimes twice, occasionally wrong.

At that scale the useful question is not "which database is best?" It is **which store for which access pattern, and what does each store do quietly when the data stops behaving?** Every store on this platform is a reasonable choice. Each one also has a failure mode that reports success.

---

## 1. Access patterns come first

Before choosing a store, write down how the data is written and read:

| Access pattern | Shape | What matters | Store |
|---|---|---|---|
| Ingest interval readings | Huge volume of small writes, mostly recent | Write throughput, safe retries | Wide-column database (Cassandra) |
| One meter over a time range | Lookup by meter, range scan on time | Locality | Wide-column (recent), object storage (history) |
| Corrections, re-deliveries | Rewrite existing readings | Overwrite without duplicates | Same, via upsert |
| Historical backfill | Months of data for many meters | Must not starve live traffic | Object storage |
| Customer, home, meter, token lookups | Key lookups on every ingested record | Low-latency reads under write load | Wide-column, plus a shared cache (Redis) |
| Chunk status | Small, frequent keyed updates | Fast keyed writes | Wide-column |
| Billing cycles, enrollments, appliance profiles | Inserts, insert-or-update, small transactions | Constraints, transactions | Relational (MySQL) |
| Personal data | Kept apart from operational data | Isolation | Separate relational user store |
| Audit milestones, tracking and analytics events | Append-only, queried in aggregate | Scans, joins, SQL | Warehouse (Redshift) via a streaming delivery service |
| Failed lines, max-demand readings, raw history | Large, rarely read, durable | Cost per byte | Object storage (S3) |
| Coordination | Mutual exclusion across workers | Short-lived locks | Redis |

The dominant pattern is "write a small value keyed by meter and time, then read a contiguous range for one meter". Almost nothing on the raw-reading path needs joins, ad hoc filters or multi-row transactions. That decides the main store.

---

## 2. Why a wide-column store fits, and what it costs

The reasons behind the original database choice are not written down anywhere I can point to, so I won't pretend to know them. I can check the choice against the access patterns. It holds up, with costs that drive the rest of this post.

**What it gives this workload:**

- **The key matches the query.** A partition per meter and time bucket, sorted by timestamp, turns "this meter, this range" into a read of a few contiguous partitions.
- **Cheap, evenly spread writes.** Writes go to a log and memory table and merge later. Millions of meters as partition keys spread load across the cluster.
- **Every insert is an upsert.** Writing an existing key overwrites it, with no read and no error. That is what makes at-least-once delivery safe.
- **Data can expire on its own.** Row TTLs plus time-window compaction let old data drop out in whole files.

**What it costs:**

- **No joins, no ad hoc queries.** One table per query. "All meters where…" belongs elsewhere.
- **Partition sizing is your job.** Get the bucket wrong and partitions grow without bound.
- **Deletes are writes.** A tombstone is written and compacted away later.
- **TTL counts from the write, not from the data.** Section 7 shows this one fact shaping an entire redesign.
- **Capacity problems become correctness problems.** When the database is slow, workers retry, give up and skip records. A node whose JVM would not start (a port conflict with a monitoring agent) caused a spike in ingestion failures. During a period of database read timeouts, records failed after all retries.

---

## 3. Key design: bucket the time, bound the partition

The raw-readings table uses this key:

```
partition key:   (customer, home, gateway, meter, time bucket)
clustering key:  reading timestamp
```

The bucket is not a calendar month. It is a fixed 30-day window:

```
bucket = epoch_seconds / 2,592,000      (integer division; 30 × 86,400)
SYNTHETIC: 1,700,000,000 / 2,592,000 = 655
```

No calendar, no time zone, no month lengths. Every service computes the same number from the same timestamp.

### Partition-sizing arithmetic

Partitioning by meter alone would put every reading a meter ever produces into one partition. The bucket caps it:

| Interval | Readings per day | Rows per 30-day partition |
|---|---|---|
| 60 minutes | 24 | 720 |
| 15 minutes | 96 | 2,880 |

The cap does not depend on how long the customer stays. A year of one meter's data is about 13 partitions; a day is one.

The newer table in section 7 goes further: it clusters by **day within the bucket** (0–29), each row holding a map of that day's readings. A partition has at most 30 rows. Using the design's estimate of about 18.7 KB per day-row as a text map at 15-minute intervals, a full partition is about 30 × 18.7 KB ≈ 560 KB.

Two details from that table are worth stealing:

- **The bucket replaced a calendar-month text column.** Deriving a month string meant parsing dates in a time zone. An integer from epoch seconds cannot depend on one.
- **Match column types to the driver exactly.** The day and bucket columns were first declared as small integers while the application bound regular integers. The driver failed at runtime with a codec error, and the columns became plain integers.

The cost: a query spanning N buckets is N partition reads. In the newer design they run one after another; parallelising them is future work.

**Lesson:** size partitions with arithmetic before writing the schema, and choose a bucket every service can compute without a time zone.

---

## 4. Upserts: retries become safe, collisions become silent

A worker deletes its queue message only after success, so a crash means the chunk is processed again. The key makes that safe:

```
attempt 1: (meter M, bucket 655, ts T) = 0.42   → row created
attempt 2: (meter M, bucket 655, ts T) = 0.42   → same row, same value
```

The same property means the database cannot tell a retry from a collision. If two **different** readings produce one key, the second overwrites the first and both writes succeed. Duplicates can vanish even earlier: the write path groups a batch by timestamp in memory, so two readings with one timestamp in a batch collapse to one, last wins, nothing counted.

### The spring-forward collision

A partner sent local timestamps that stayed on standard time all year. The ingestion configuration read them in a zone that observes daylight saving. From the March transition, every reading in the daylight-saving months was stored an hour early. On the spring-forward night, 02:00 does not exist in the configured zone, so the 02:00 and 03:00 readings mapped to one instant and one overwrote the other. The partner noticed first: electric-vehicle charging appeared to start an hour before the overnight rate. The fix, a configuration correction plus re-ingestion of the affected raw data, has shipped.

A synthetic version, in a zone moving from UTC−5 to UTC−4 at 02:00 local:

| Partner label (standard time) | True instant (UTC) | Parsed in DST-aware zone as | Stored key (UTC) | Outcome |
|---|---|---|---|---|
| 01:00 | 06:00 | 01:00 −05:00 | 06:00 | correct |
| 02:00 | 07:00 | non-existent; lenient parser moves it to 03:00 −04:00 | 07:00 | overwritten |
| 03:00 | 08:00 | 03:00 −04:00 | 07:00 | overwrites 02:00 |
| 04:00 | 09:00 | 04:00 −04:00 | 08:00 | an hour early |

Four readings in, three keys out, four successful writes, and a chart that still looks plausible. (Parsers differ on non-existent local times; "moves forward" is common lenient behaviour, not a universal rule.)

It was not the first time. In 2024, invoice ingestion broke after a daylight-saving change because a configuration used fixed Eastern Standard Time instead of a DST-aware zone. A requirements document for the raw file format now says re-delivering a file must not create duplicates, and records the risk that documents repeating local-time labels could overwrite each other because the stored key dropped the offset. Idempotency also has to be re-earned: re-ingesting the same file once created duplicate meters (2023), and once produced different billing cycles within a month (2021). Both were fixed.

### What actually defends you

Giving up upserts would make retries create duplicates. The defences move to the edges:

- **Time rules in the onboarding contract:** zone, offset, interval start or end.
- **Keep the offset or original string** next to the epoch value, so collisions can be audited.
- **Count distinct keys, not successful writes.** Compare distinct (meter, timestamp) pairs after parsing with distinct keys stored for that range. A shortfall is a collision.
- **Check counts per local day.** A DST zone has 23-, 24- and 25-hour days. The wrong count is a time-zone bug even when nothing collided.

**Lesson:** the property that makes retries safe also hides collisions. Detection has to live outside the database, because the database will never complain.

---

## 5. "Last writer wins" needs a definition of "last"

A recent re-billing investigation found that corrected invoices are applied in the order files are processed, not the order of the billing periods they describe, with no ordering across files at all. Replay an older file and it can reinstate an older billing cycle:

```
SYNTHETIC
file A (arrives Monday):   cycle Mar, corrected amount  → stored
file B (arrives Tuesday):  cycle Mar, original amount   → overwrites A
```

The hot/cold design in section 7 stamps each record with a last-updated time and resolves disagreements between stores by it. That is the right tool for making two copies of a reading agree. But the stamp measures **when the platform wrote the record**: arrival order with better bookkeeping, not business order. If the newest write carries the oldest truth, the stamp prefers it.

When business order matters, the record must carry it (a statement date, a revision number, a source sequence), and something must compare before keeping a value: the write, at the cost of a read, or the reader.

**Lesson:** for every last-writer-wins rule, write down which clock defines "last", and check it is the one the business cares about.

---

## 6. The other stores, and why they are not the main database

**Relational, where constraints beat volume.** Billing cycles are row inserts. Program enrollments use insert-or-update. Appliance profiles are batched insert-or-update statements inside a transaction. Personal data sits in a separate user store. These records are few compared with readings, they relate to each other, and partial state is worse than none. All-or-nothing across a customer's appliance profiles is a guarantee the wide-column store does not give across partitions, and a unique constraint turns a would-be silent duplicate into an error.

**A warehouse for questions nobody planned.** Audit milestones, tracking and analytics events flow to a warehouse through a streaming delivery service. "How many chunks for this utility failed last Tuesday?" needs scans and group-bys no partition key anticipated. The cost is latency: as the [overview](/writing/every-record-accounted-for) notes, audit evidence can arrive many hours late. Anything needing a fast answer about one chunk should not depend on it.

**Object storage for history and leftovers.** Failed lines, max-demand readings and long-term raw history live here. It is the cheapest durable store per byte and good at whole-object reads and writes. It cannot append one reading; it can only write the whole object again, and every write is billed. That is the next section's problem.

**Redis for coordination.** It holds distributed locks and the shared customer cache. Here it matters as the lock service for object-storage writes.

---

## 7. The hot/cold redesign

### The problem: a read-modify-write per batch

Before the redesign, raw readings lived **only in object storage**, one file per meter per 30-day bucket. Every ingest batch read the file, merged new readings in, and wrote the whole file back: many full-object writes per meter per day.

```
SYNTHETIC: one meter, 24 ingest batches in a day
before:  24 × (GET month file + PUT whole month file)
goal:    24 small database upserts now, 1 PUT when the bucket closes
```

The goals: collapse the daily object-storage writes into one archival write per bucket, and serve recent reads from the database. The design is documented and under implementation, not yet the production path; read what follows as the design.

### The layout and routing

The new table keeps the partition key (customer, home, gateway, meter, bucket) and clusters by day within the bucket, each row a map from reading timestamp to serialized reading. Default TTL is 60 days, with time-window compaction in 7-day windows and a 5-day tombstone grace period. The bucket number is the same one used in the object-storage key, so both stores split time identically.

```
stamp every record: last_updated = now

routing flag ON for the customer group (default):
    ts ≥ start of current bucket → database (+ object storage while dual-write is on)
    ts <  start of current bucket → object storage only
flag OFF (historical/backfill onboarding):
    everything → object storage

read:
    range inside current bucket  → database only
    range starts earlier         → database AND object storage, whole range;
                                   merge by timestamp, higher last_updated wins;
                                   unstamped legacy records lose
    flag cannot be resolved      → object storage only
```

That last line deserves a pause. If the flag lookup fails, recent readings that exist only in the database become invisible. Dual-write covers this while it is on; once it is off, a failed lookup is a read that returns partial data without error. Reviewers flagged a related trap: a per-group routing flag and a global dual-write flag are easy to confuse.

### The rejected design: route by age

The obvious rule: write a reading to the database if it is newer than *now minus TTL*, otherwise to object storage, and read with the same cutoff. The design document works it through with a 40-day TTL:

| Date | Event | Cutoff (now − 40 d) | Object storage gets | Database gets |
|---|---|---|---|---|
| July 10 | First ingest, Jan 1 – Jul 10 | June 1 | Jan 1 – May 31 | Jun 1 – Jul 10 |
| July 20 | Re-ingest with corrections, Jan 1 – Jul 20 | June 10 | Jan 1 – Jun 9 | Jun 10 – Jul 20 |

After July 20, June 1–9 is **fresh in object storage and stale in the database**. The second run never wrote those days to the database, so the July 10 copy is never overwritten. Every read strategy now fails:

| Read strategy | Result |
|---|---|
| Database first | Serves the stale June 1–9 copy |
| Age-aware read on July 25 (cutoff June 15) | Object storage has data only to June 9; the database window starts June 15. **June 10–14 vanish.** |

The obvious patch, "also rewrite the overlap into the database", fails too. Rewriting June 1 data on July 20 resets its TTL, so old data lives as long as new data. Re-ingest every few weeks and old readings stay in the hot tier indefinitely.

### The root constraint: TTL counts from the write

Every failure above comes from one fact: **the database's TTL is based on write time, not on the reading's timestamp.** Route by the reading's age while expiry runs on the write's age, and the two clocks drift apart on every re-ingestion. No merge rule fixes that, because the stores disagree about which data should exist at all.

So the cutoff must not move with the clock. The chosen rule uses the **start of the current bucket**, which moves once every 30 days. The same story with a fixed boundary (the bucket grid does put a boundary at 2026-07-06 00:00 UTC):

| Date | Event | Boundary | Object storage gets | Database gets |
|---|---|---|---|---|
| July 10 | First ingest, Jan 1 – Jul 10 | July 6 | Jan 1 – Jul 5 | Jul 6 – Jul 10 |
| July 20 | Re-ingest, Jan 1 – Jul 20 | July 6 | Jan 1 – Jul 5 | Jul 6 – Jul 20 (overwrites Jul 6–10) |

Same input, same split, whenever it runs. Older readings never enter the database, so they cannot leave stale pockets there. When the boundary moves, the closed bucket is still in the database until it expires, and reads across it merge both stores by last-updated.

A side effect matters as much: **a historical backfill never touches the database.** Reviewers had raised backfill capacity; an estimate under a different design put a 26-month, 15-minute backfill for one million users at about 7.2 TB with three replicas. Now that data goes straight to object storage.

### Why 60 days: the archival window

A bucket's earliest readings are written on its first day. With a 60-day TTL they expire 30 days after the bucket closes, so the archival job has about 30 days to copy the closed bucket to object storage. With 40 days, it had about 10.

```
day 0 ─────────── day 30 ─────────────────── day 60
│ bucket open     │ bucket closed            │ earliest rows expire
│ (writes)        │ ←── archival window ──→  │
```

That makes archival the design's critical dependency. If TTL fires first, the data is gone permanently, so **archival lag alerting is mandatory**. The archival job is still being designed. Its requirements so far:

- **Merge by last-updated, never blind overwrite.** A correction to a closed bucket goes straight to object storage, which may already be newer than the database copy.
- **Take the same per-file lock** as other writers, and **fail closed**.
- **Be idempotent** and safe against concurrent deletes.

One more trap: deleting an archived partition does not free disk early. Under time-window compaction the tombstone lands in a later window, so space returns only when data expires. Plan for about two full buckets.

### Writes: parallel upserts, not batches

Readings are grouped by day, and each day becomes one update that merges entries into that day's map, with no read first. Re-ingestion replaces individual readings without wiping the rest of the day.

The day statements are sent asynchronously, one future each, then joined. They are not a database batch: a batch spanning partitions makes one coordinator write a batch log and fan out, adding overhead and buying nothing, because the writes are independent and idempotent. If one fails, the unit is retried and the successful days are rewritten harmlessly.

```java
// Illustrative, written for this post
List<CompletableFuture<?>> writes = new ArrayList<>();
for (DayRow day : rowsByDay) {
    // UPDATE ... SET readings = readings + :entries, last_updated = :now WHERE <key> AND day = :d
    writes.add(session.executeAsync(mergeDay(day)).toCompletableFuture());
}
CompletableFuture.allOf(writes.toArray(new CompletableFuture[0])).join(); // any failure → retry the unit
```

### The write that fails silently

Object-storage writes are where the new design meets the old path. A write reads the month file, puts new entries on top (an incoming reading replaces an existing one **without comparing last-updated stamps**), and writes it back, under a per-file distributed lock (up to 60 seconds to acquire, 300-second expiry), with up to 10 retries.

After the last retry, the exception is **logged and swallowed**. The caller is not told.

Follow that through:

- On the historical path, a reading that was never stored counts as ingested: the overview's "2 ingested, 0 failed" from a different cause.
- On the dual-write path, the safety net can have holes nobody sees until it is needed.
- The object-storage merge ignores last-updated while the read path honours it, so racing writers can leave a winner a reader would not have chosen.

**Lesson:** retrying inside a write is fine; deciding inside a write that failure doesn't matter is not. Return the failure and let the caller retry, record or stop. That is why "fail closed" is an archival requirement.

---

## 8. Provisional capacity numbers

These are **provisional back-of-envelope estimates from the design work, not measurements.** They show the method and its sensitivities.

| Quantity | Basis | Estimate |
|---|---|---|
| Users in scope | | ~39.6 million |
| Readings per day | 15-minute interval | 96 |
| Size per reading | JSON | ~182 bytes |
| Day-rows per bucket | 39.6M × 30 | ~1.19 billion |
| Readings per bucket | 1.19B × 96 | ~114 billion |
| Size per bucket | uncompressed | ~22 TB |
| Steady state | ~2 buckets, replication factor 3, 3–5× compression | ~27–45 TB |
| With compaction headroom | | ~35–58 TB |
| Average writes | 39.6M day-rows a day ÷ 86,400 s | ~459/s |
| Peak writes | 4× average | ~1,835/s |

Steady state is about two buckets because of the TTL and compaction behaviour above: one open, one closed and waiting to expire.

The most sensitive input is the row format. An earlier cost analysis assumed a packed binary row of about 4.7 KB per user-day; a JSON map is about 18.7 KB. **Serialization changes storage by about 4×**, more than the whole compression range. Settle it with numbers before the schema ships, because changing it later means rewriting every row.

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
