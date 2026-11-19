---
title: "Running a Distributed Ingestion Pipeline Reliably"
subtitle: "What at-least-once delivery, retries, ordering gates and tenant queues each guarantee, and where each guarantee stops"
slug: distributed-pipeline-reliability
date: 2026-11-29
series: every-record-accounted-for
part: 3
status: published
tags: [distributed-systems, reliability, queues, ingestion, java]
---

A queue-driven pipeline looks healthier than it is. Failed work rarely disappears: it goes back on a queue, sleeps on a thread, waits behind someone else's backlog, or is skipped into an error file, and each of those looks like progress from somewhere.

The platform I work on [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters. The [hub post](/writing/every-record-accounted-for) followed one file through a generic, made-up pipeline. This part goes through the usual reliability mechanisms one at a time: what each one guarantees, and the failure pattern that shows where the guarantee stops. The incidents below are composites or made-up examples, and every number in them is for illustration.

---

## 1. At-least-once delivery holds only if the timers add up

Every stage reads from a queue and follows one rule: **the worker deletes the message only after processing succeeds.** If an exception escapes or the process dies, the message stays where it is. It is invisible while its visibility timeout runs, then becomes visible again for any worker to receive. A dead-letter queue catches a message that keeps failing, so it is eventually moved aside rather than retried forever.

That gives at-least-once delivery, with four settings that interact:

| Setting | What it decides | What goes wrong if it is wrong |
|---|---|---|
| Delete on success | Crash safety | Delete early and a crash loses work |
| Visibility timeout | How long one attempt owns a message | Too short gives duplicate processing; too long delays recovery |
| Prefetch | How many messages a worker holds before it has threads for them | Timers run while messages wait |
| Max receives → dead-letter | When to stop retrying | Too low parks transient failures; too high retries poison for days |

The timeout should differ by queue, because a chunk of a large file and one aggregation request do very different amounts of work.

Here is the timeline for a message that fails every time (synthetic; *N* stands for the max-receive count):

```
t=0        receive #1 ──► processing ──► exception, no delete
           │◄──────── visibility timeout ────────►│
t=VT                                               visible again
t=VT+ε     receive #2 ──► processing ──► exception, no delete
           │◄──────── visibility timeout ────────►│
  …
t≈(N-1)·VT receive #N ──► exception
                                                   moved to dead-letter queue
                                                   (someone must watch it,
                                                    and know how to redrive it)
```

### Prefetch steals time from the timer

Receiving is cheaper in batches, so queue clients commonly ask for several messages per call and cache the extras locally. A common shortcut is a bounded executor that admits more tasks than it has threads, with the polling loop blocking when it is full. The catch is that a message is fetched before a thread is free, so it can sit waiting while its visibility timer is already running. The cleaner design has each worker poll for itself and never hold a message it cannot start.

A worked example, synthetic:

```
10 threads, 20 messages held, visibility timeout 120 s
message #15 waits 90 s for a thread, then runs for 60 s
  → it finishes at 150 s
  → at 120 s it became visible again, and another worker started it
```

Nothing failed, and the work ran twice, which is acceptable only if running it twice is harmless.

### Exactly-once is not the goal

Make duplicates harmless instead. If storage writes are upserts keyed by meter and reading time, a reading written twice leaves one row. Exactly-once across a queue, a cache, a database and object storage is not worth chasing. The price is that idempotency must hold at every side effect, and downstream publishes are where it is easiest to miss (section 5).

For every queue, write down the 99th-percentile processing time plus the longest a message can wait in the prefetch buffer, and compare the sum with the visibility timeout. If they are close, some messages are already being processed twice.

---

## 2. The poisoned cache: when the failure is not an Exception

### A hypothetical setup

Imagine customer records that are read on almost every ingested line, so they are cached in two tiers: an in-process cache in each JVM, in front of a shared cache with a TTL measured in days. Shared entries are stored as compact binary by a **positional serializer**: it writes fields in a fixed order (alphabetical by name, in this example) with no field names and no schema version. The cache key has no version either.

A release adds one field to a cached class, and it sorts somewhere in the middle.

### What a positional reader does with old bytes

The old class has five fields; the new class adds `email`, which sorts second:

| Position | Old writer wrote | New reader expects | New reader gets |
|---|---|---|---|
| 1 | `accountId` (String) | `accountId` (String) | correct |
| 2 | `homeAddress` (Address) | `email` (String) | an Address's bytes read as a String |
| 3 | `postcode` (String) | `homeAddress` (Address) | a String's bytes read as an Address |
| 4 | `signupDate` (Calendar) | `postcode` (String) | a Calendar's bytes read as a String |
| 5 | `timeZone` (String) | `signupDate` (Calendar) | a String's bytes read as a Calendar |
| 6 | (none) | `timeZone` (String) | end of stream |

Every field after the inserted position is shifted, and two things follow, which is why a failure like this is partial:

- **Most misread entries throw during deserialization.** The bytes make no sense as the expected type, the read fails, and the cache reloads the record from the database. That path is healthy.
- **Some entries decode "successfully".** If the serializer sets fields without type checks, a field declared as an `Address` can end up holding a string or a calendar object. Those entries sit in the shared cache, broken, until something rewrites them or the TTL expires.

The crash comes later, when code uses one of those objects and the JVM throws `IncompatibleClassChangeError`.

### Why every catch block misses it

```
Throwable
├── Exception                         ← what the ingestion path catches
│   ├── IOException
│   └── RuntimeException
│       └── ClassCastException
└── Error                             ← what actually happens
    ├── LinkageError
    │   └── IncompatibleClassChangeError     ← this one
    │       ├── NoSuchFieldError
    │       ├── NoSuchMethodError
    │       └── AbstractMethodError
    └── VirtualMachineError
        ├── OutOfMemoryError
        └── StackOverflowError
```

`IncompatibleClassChangeError` is an `Error`. It passes through every `catch (Exception e)` on the record path and the message path, and kills the worker thread. Without an uncaught-exception handler, the JVM's default handler prints each death to the console output, never to the application log that dashboards and alerts read.

### What the pipeline looks like from outside

```
chunk received ──► records 1 … k applied ──► record k+1 (bad cached customer)
                                                   │
                                          thread dies, no log line
                                                   │
           no delete ◄─────────────────────────────┘
           no status update, no completion event, no error report
                                                   │
     one visibility timeout later: redelivered ──► records 1 … k again ──► dies again
```

Records before the bad customer are re-applied on every redelivery, harmlessly, because writes are upserts. Records after it are never processed. The chunk stays "in progress" for as long as anyone looks, and every service that reads the same cache is exposed in the same way.

### Mitigation, in an order that does not recreate the problem

1. Confirm every service runs the new class version, so nothing writes old-format entries again.
2. Delete only old-format entries, with a cleanup script that supports a dry run, and tell every JVM to drop its local copy.
3. Restart the affected workers.
4. Redrive the dead-letter messages.

### Catch LinkageError, not Throwable, and always add a handler

Prevention has four parts:

- **Version the cache key**, so a class change reads a new key and misses cleanly instead of reading old bytes.
- **Treat a linkage error on cache read as a failed read**: evict, and reload from the database.
- **Catch broader errors at the record and message boundaries**, and attach an uncaught-exception handler so a thread death is logged and counted.
- **Add a test that fails when a cached class changes without a version bump**, or move to a serializer with tagged fields.

The simplest boundary catch is `catch (Throwable t)`. It catches this failure, but it also catches `OutOfMemoryError` and `StackOverflowError`, which mean the JVM itself may be in a state where carrying on is unsafe. I prefer catching only the linkage family and letting VM errors propagate:

```java
// Illustrative, not production code.
for (Record r : chunk) {
    try {
        process(r);
    } catch (Exception | LinkageError e) {
        // A bad record or bad class data: reject this record, keep the thread.
        rejectRecord(r, e);
    }
    // VirtualMachineError is deliberately not caught: let the thread die,
    // let the handler report it, let the process be replaced.
}
```

```java
Thread.UncaughtExceptionHandler reportDeath = (thread, error) -> {
    log.error("worker thread died: " + thread.getName(), error);
    metrics.increment("ingestion.worker.thread_death");
};
```

The narrow catch is right only together with the handler, because without one the next unlisted error type reproduces the same silent death. A handler also fires only for work started with `execute()`; `submit()` stores the failure in a `Future` nobody reads.

The cache-read catch is weaker than it looks, since a mis-decoded object can survive the read and fail elsewhere. The versioned key stops a wrong object being returned at all, and the catch is the second line of defence.

A failure that never reports itself can only be found by noticing what is missing, so alert on "started but not finished after T" as well.

---

## 3. Retries under a slow database

### An example policy

Suppose ingestion looks up the meter and the customer for each group of readings before it writes, so a slow database is felt at once. Here is a retry policy that reads well in review (the numbers are made up):

- **Transient** means anything that looks like a timeout or a dropped connection. Anything else is rethrown at once.
- **Four attempts**, with exponential backoff from two seconds: sleeps of 2, 4 and 8 seconds.
- The sleep is a plain `Thread.sleep` **on the worker thread**.
- **After exhaustion** the record group goes to the error file with a generic internal-error code, a metric is incremented, and the loop moves on to the next customer.

Each part is defensible on its own. Together they behave badly in exactly the situation retries exist for.

### Backoff holds pool threads

Sleeping on a worker thread is cheap for the record and expensive for the pool. A sleeping thread holds a pool slot and an executor permit. When the database is slow for everyone, every thread is likely asleep at once, and the pool's useful capacity drops just as the backlog grows.

Assume, for illustration, a driver request timeout of 10 seconds per attempt. One call to an unresponsive database then costs:

```
4 attempts × 10 s timeout   = 40 s
3 sleeps   (2+4+8)          = 14 s
                              ────
                       ≈ 54 s per call
```

The policy has no memory across calls, so the next customer group in the same chunk starts from attempt one and pays the same 54 seconds. A synthetic chunk with 2,000 customer groups, all failing, takes about 30 hours of one thread's time to fail. Long before then its visibility timeout has expired, and another worker is running the same chunk into the same wall.

### What exhaustion turns into

A failure pattern I have seen in pipelines like this: the customer database is unavailable while an enrollment file is processed. Every record exhausts its retries and is skipped into the error file. Later files for those customers then fail with "user does not exist", so one outage becomes a cascade of permanent errors, reported with the same code as a bug.

Skip-and-continue is the right default for a bad record and the wrong one when *every* record fails for the same infrastructure reason.

### What I would design instead

- **A retry budget.** Cap total retry time per chunk, not just attempts per call. When the budget is spent, stop retrying.
- **A circuit breaker per dependency.** After a run of exhausted calls, open the breaker: fail the *chunk*, leave the message undeleted, and let the queue redeliver it after the database recovers, instead of skipping records one at a time. Upserts make the redelivery safe.
- **Jitter**, so workers do not retry in lockstep against a recovering database.
- **A distinct error code** for "infrastructure exhausted", with a replay path.
- **Adaptive concurrency**: when latency rises, call the database from fewer threads instead of keeping them all asleep.

A retry policy decides what happens *after* the last attempt. If the answer is "skip", the skip has to be distinguishable, counted and replayable.

---

## 4. Ordering gates must check after the wait

Some files depend on others. An enrollment file creates customers; a preference file sets their communication preferences. Process the preference file first and every line fails with "user does not exist".

A common answer is a gate: before reading from a queue, a listener checks whether any file of an earlier-ranked type is still waiting. If the check runs *before* a long poll, it is a check-then-act race across the wait (times synthetic):

```
09:59:55.0  gate: no earlier file pending  ✔
09:59:55.0  long poll starts (up to 20 s)
10:00:00.0  enrollment file lands
10:00:01.0  preference file lands
10:00:01.5  poll returns the preference message
            processed without re-checking the gate
            → "user does not exist" for every line
            → message deleted as processed; never retried
```

Any producer that drops both files close together can hit this, and the cost is quiet: the dependent records are lost with no retry.

### Defer, don't fail

Re-check the gate **after** a message is received. If an earlier file is still pending, the listener neither processes nor deletes the message, and the queue redelivers it after the visibility timeout. Waiting moves from an in-memory loop to the queue, which already knows how to hold work and survives a restart.

Two costs come with that:

- **"Not yet" lasts a full visibility timeout**, not a few seconds. For files that arrive daily, that is fine.
- **The check is not free.** If it lists object storage for each earlier-ranked type, it now does so per received message, and that load needs measuring.

A message deferred often enough will reach the max-receive count and land in the dead-letter queue. If an enrollment file is stuck, that is where its dependants should end up, as long as it is intended.

"Not yet" and "never" need different answers: a dependency failure should defer, and only a data failure should reject.

---

## 5. Fan-out: one event, many messages

Suppose every ingested upload raises downstream work: an aggregation request for the customer and, depending on configuration, a second, derived-analytics request. If the time range comes from the upload event, volume scales with *events × range*.

Fan-out is also where idempotency is thinnest. If the source message is deleted only after both downstream messages are published and the second publish fails, redelivery publishes the first one again. Each duplicate is harmless when aggregation recomputes from stored data. The *count* is not harmless.

### How a flood starts

Two shapes are common. A long historical backfill triggers an aggregation per upload, each covering a wide range, and keeps doing so for as long as the file is processed. Or a tenant's daily update file triggers an aggregation for every changed row, on a queue that tenant shares with everyone else.

Made-up numbers show why such a backlog does not drain itself:

```
backlog            10,000,000 messages
drain rate         ~200 per min  = ~288,000 per day
time to drain      10,000,000 / 288,000 ≈ 35 days
                   (plus whatever arrives meanwhile)
```

### Drain, purge, or replay

| Option | What it does | Safe when |
|---|---|---|
| Drain | Let workers process the backlog | Rate × time is acceptable and the work is still wanted |
| Purge | Delete everything in the queue | Every message can be regenerated, for every tenant on it |
| Replay / redrive | Re-send parked messages | The messages are still correct and the cause is fixed |
| Targeted delete | Remove one tenant's messages only | That tenant's work is redundant and can be regenerated |

In the example, draining takes weeks, a purge destroys every *other* tenant's messages, and redriving recreates the flood. The option that works is a targeted delete of the flooding tenant's messages, plus a routing change made separately. That needs a tool that removes one tenant's messages and leaves the rest. It is safe when messages say "this customer needs recomputing" rather than carrying data, because deleted work can then be recreated deliberately.

Coalesce fan-out per customer per file, give backfills their own lane, and build the per-tenant delete tool before you need it, because "purge" is the only button most queues come with.

---

## 6. Tenant isolation: the quiet neighbour

Partition queues by group: a routing file maps tenants to groups, each group gets its own queue and consumers, and tenants not in the file share a default queue.

Now imagine two tenants with very different workloads in one group. The heavy one keeps the consumers busy; the light one's messages wait. Nothing errors, so the logs are clean, and the delay can grow for days before anyone looks. The usual fix is to give the starved tenant its own partition. The harder question is why the monitoring stayed quiet, and three common design choices answer it:

- **Autoscaling on depth, not age.** An alarm on the visible message count, averaged over minutes, misses a slow, steady starvation that stays under any threshold a healthy backfill is allowed to exceed. Many depth metrics also leave out in-flight messages.
- **An age metric that measures the past.** Stamping each message at send time and recording time-to-receive gives age *at dequeue*. A message nobody reads produces no data point until somebody reads it, so the metric reports a starvation only after it ends. What you want is the age of the oldest waiting message.
- **Fairness as deploy-time configuration.** Routing should be reloadable without a release, and a missing or invalid routing config should fail loudly, never fall back silently to one shared queue.

Little's law (a general queueing result) says why depth misleads: wait ≈ depth ÷ throughput. Flat depth with falling throughput means rising wait, and no depth alarm will see it. Synthetic: 800 messages waiting, throughput falling from 400 a minute to 20 a minute, means the wait grows from 2 minutes to 40 with depth unchanged.

Alarm on the age of the oldest message, per tenant group, and treat a fallback to the default route as an incident rather than a log line. [Part 4](/writing/end-to-end-visibility) covers what else that alarm needs.

---

## 7. Partitioning and single ownership come before scale-out

"Add more machines" assumes that work can be split and that two machines will not do the same work. Imagine a file-pickup layer with one listener thread per queue, and one queue per customer and file type, all feeding a small task pool through a semaphore. Adding listeners adds threads competing for the same few permits, which means more contention and no more throughput. If every install also starts every role, scaling one role scales all of them.

A design that scales has four parts:

1. **Role-based start flags**, so pickup, chunking and processing scale independently.
2. **Distributors that partition work**, for example a consistent hash into N shard queues.
3. **Single ownership** of each file, through a lock with a TTL and explicit release, or through deterministic partitioning.
4. **An idempotency key per file**, with lifecycle states (received → chunking → chunked → uploaded), so a duplicate is acknowledged as a no-op.

At-least-once delivery plus idempotent processing is very likely sufficient here. The risks are in the details:

- **Lock TTL.** Too short gives duplicates from a slow owner; too long stalls a file behind a dead one. A lock is a lease, and the idempotency key makes an expired lease survivable.
- **Listing load.** More pickup workers mean more listing connections, which can overload an SFTP server.
- **Ordering versus the shard key.** Enrollment and preference files for one customer have different file types, so hashing customer *and* file type can put them on different shards, and the section 4 gate must then work across shards. Sharding on customer alone keeps them together, at the cost of a hot shard for a large customer. The ordering constraint decides the key.

---

## 8. Choose the unit of rejection on purpose

When part of an input is bad, what do you reject? The answer differs by data type, and it should be a decision rather than an accident of where a `catch` block sits.

- **Raw readings: the row.** Bad rows go to the error file, and good rows in the same chunk are written.
- **Invoices: the bill.** Imagine an invoice with twelve line items, two of them invalid: one has a blank cost, the other an unknown charge type. A parser that fails fast rejects all twelve lines with an "invoice not processed" error.
- **Configuration failures: the chunk.** If the file cannot be interpreted at all, the chunk fails.

The invoice rule looks harsh, but the reasoning holds. A bill is a total, and if ten of twelve lines are ingested, the stored bill has a plausible, wrong amount that nothing flags. The cost is a visible blast radius: ten valid lines come back with the same error as the two bad ones. So with document-level rejection, the report should say *which* lines caused it.

Write the unit of rejection per data type into the onboarding contract, and make the error report point at the cause, not just the casualties.

---

## A checklist before trusting a stage

**Delivery**
- [ ] Is the message deleted only after success, including every side effect?
- [ ] Is p99 processing time plus prefetch wait comfortably below the visibility timeout?
- [ ] Is every side effect idempotent under redelivery, including downstream publishes?
- [ ] Does someone watch the dead-letter queue and know how to redrive it?

**Failure handling**
- [ ] Does the worker boundary catch everything that means "this record is bad", `LinkageError` included?
- [ ] Is there an uncaught-exception handler that logs and counts thread deaths?
- [ ] Is there an alert for "started but not finished after T"?
- [ ] Is every class in a shared cache versioned in its key, with a test that enforces it?

**Retries**
- [ ] Are backoff sleeps holding pool threads, and what does the pool look like when every call is failing?
- [ ] Is there a retry budget or circuit breaker, so an outage fails the chunk instead of skipping every record?
- [ ] Does "retry exhausted" have its own error code and a replay path?

**Flow**
- [ ] Are dependency checks made after the wait, and do they defer rather than fail?
- [ ] Is fan-out coalesced per customer per file, with backfills in their own lane?
- [ ] Can you delete or replay one tenant's messages without touching the others?
- [ ] Do alarms watch the age of the oldest message per tenant group, not just depth?

**Scale**
- [ ] Does the partition key respect ordering constraints?
- [ ] Is there single ownership per unit of work, and an idempotency key that makes a lost lease safe?

Every mechanism in this post is a promise about where failed work goes. The reliable pipeline is the one where each of those places is somewhere you can see, explain and replay from.

*Views are my own. Examples are simplified or made up and do not describe any specific employer or customer system.*
