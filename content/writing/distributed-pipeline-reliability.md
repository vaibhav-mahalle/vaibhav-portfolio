---
title: "Running a Distributed Ingestion Pipeline Reliably"
subtitle: "At-least-once delivery, poison messages, slow databases, and the work you must be able to replay"
slug: distributed-pipeline-reliability
date: 2026-11-29
series: every-record-accounted-for
part: 3
status: published
tags: [distributed-systems, reliability, queues, ingestion, java]
---

A queue-driven pipeline looks healthier than it is. Failed work rarely disappears. It goes back on a queue, sleeps on a thread, waits behind someone else's backlog, or is skipped into an error file, and each of those looks like progress from somewhere.

The platform I work on [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters. The [hub post](/writing/every-record-accounted-for) followed one file through it. This part covers what each reliability mechanism guarantees, and the failure that showed where the guarantee stops.

---

## 1. At-least-once delivery: the contract

Every stage reads from a queue and follows the same rule. **The worker deletes the message only after processing succeeds.** If an exception escapes or the process dies, the message stays where it is. It is invisible while its visibility timeout runs, then becomes visible again for any worker to receive. A comment next to that rule says dead-letter queues are configured, so a message that keeps failing is eventually moved aside rather than retried forever.

That gives at-least-once delivery, with four settings that interact:

| Setting | What it decides | What goes wrong if it is wrong |
|---|---|---|
| Delete on success | Crash safety | Delete early and a crash loses work |
| Visibility timeout | How long one attempt owns a message | Too short gives duplicate processing; too long delays recovery |
| Prefetch | How many messages a worker holds before it has threads for them | Timers run while messages wait |
| Max receives → dead-letter | When to stop retrying | Too low parks transient failures; too high retries poison for days |

The timeout differs by queue, from about two minutes to an hour. A chunk of a large file and one aggregation request do very different amounts of work.

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

Receiving is cheaper in batches, so the queue client asks for up to ten messages per call and caches the extras locally. A bounded executor then admits about twice as many tasks as there are threads. When it is full, the polling loop blocks.

The code comment on that executor names the problem: a message is fetched before a thread is free, so it can sit waiting while its visibility timer is already running. The same comment suggests the cleaner design, where each worker polls for itself and never holds a message it cannot start.

A worked example, synthetic:

```
10 threads, 20 messages held, visibility timeout 120 s
message #15 waits 90 s for a thread, then runs for 60 s
  → it finishes at 150 s
  → at 120 s it became visible again, and another worker started it
```

Nothing failed, and the work ran twice. That is only acceptable if running it twice is harmless.

### Exactly-once is not the goal

Storage makes duplicates harmless: writes are upserts keyed by meter, time bucket and reading timestamp, so a reading written twice leaves one row. Exactly-once across a queue, a cache, a database and object storage is not worth chasing. The price is that idempotency must hold at every side effect, and it does not hold for every downstream message (section 5).

**Lesson:** for every queue, write down the processing time at the 99th percentile, plus the time a message can wait in the prefetch buffer, and compare that with the visibility timeout. If the sum is close to the timeout, you are already processing some messages twice.

---

## 2. The poisoned cache: when the failure is not an Exception

### The setup

Customer records are read on almost every ingested line, so they are cached in two tiers: an in-process cache in each JVM, in front of a shared Redis cache with a seven-day TTL. A small invalidation channel tells JVMs when to drop local copies. Shared-cache entries are stored as compact binary (Kryo 5, compressed). The serializer writes fields **by position, in alphabetical order of field name**, with no names and no schema version. The cache key had no version either.

A release added one field to a cached class. It sorted fifth of twenty-three.

### What a positional reader does with old bytes

A synthetic, smaller version of the same thing. The old class has five fields; the new class adds `email`, which sorts second:

| Position | Old writer wrote | New reader expects | New reader gets |
|---|---|---|---|
| 1 | `accountId` (String) | `accountId` (String) | correct |
| 2 | `homePath` (Path) | `email` (String) | a Path's bytes read as a String |
| 3 | `postcode` (String) | `homePath` (Path) | a String's bytes read as a Path |
| 4 | `signupDate` (Calendar) | `postcode` (String) | a Calendar's bytes read as a String |
| 5 | `timeZone` (String) | `signupDate` (Calendar) | a String's bytes read as a Calendar |
| 6 | (none) | `timeZone` (String) | end of stream |

Everything after the inserted position is shifted. In the real incident that meant fields 5 to 23 of every old entry.

Two things happened next, which is why the incident was partial.

- **Most misread entries threw during deserialization.** The bytes made no sense as the expected type, the read failed, and the cache reloaded the record from the database. That path was healthy.
- **Some entries decoded "successfully".** The serializer sets fields without type checks, so a field declared as a path could end up holding a string or a calendar object. Those entries sat in the shared cache, broken, for up to seven days.

The crash came later, when code copied one of those objects and the JVM threw `IncompatibleClassChangeError`.

### Why every catch block missed it

```
Throwable
├── Exception                         ← what the ingestion path caught
│   ├── IOException
│   └── RuntimeException
│       └── ClassCastException
└── Error                             ← what actually happened
    ├── LinkageError
    │   └── IncompatibleClassChangeError     ← this one
    │       ├── NoSuchFieldError
    │       ├── NoSuchMethodError
    │       └── AbstractMethodError
    └── VirtualMachineError
        ├── OutOfMemoryError
        └── StackOverflowError
```

`IncompatibleClassChangeError` is an `Error`. It passed through every `catch (Exception e)` on the record path and the message path, and killed the worker thread. The threads had no uncaught-exception handler, so each death was written only to the process's raw stdout file, never to the application log that dashboards and alerts read.

### What the pipeline looked like from outside

```
chunk received ──► records 1 … k applied ──► record k+1 (bad cached customer)
                                                   │
                                          thread dies, no log line
                                                   │
           no delete ◄─────────────────────────────┘
           no status update, no completion event, no error report
                                                   │
          ~30 min later: redelivered ──► records 1 … k applied again ──► dies again
```

Records before the bad customer were re-applied on every redelivery, harmlessly, because writes are upserts. Records after it were never processed. The chunk was "in progress" for as long as anyone looked. On one host, sixteen worker threads died this way: twelve in consumption ingestion, two in meter enrollment and two in user re-ingestion. Any other service reading the same cache was probably exposed too.

### Mitigation

The order matters, because each step must not recreate the problem:

1. Confirm every service runs the new class version, so nothing writes old-format entries again.
2. Delete only old-format entries, identified by remaining TTL, with a dry-run-capable cleanup script. Bump invalidation timestamps so every JVM drops its local copy.
3. Restart the affected workers.
4. Redrive the dead-letter messages.

### The fix plan, and the argument inside it

The plan has four parts:

- **Version the cache key**, so a class change reads a new key and misses cleanly instead of reading old bytes.
- **Treat a linkage error on cache read as a failed read**: evict, and reload from the database.
- **Catch broader errors at the record and message boundaries**, and attach an uncaught-exception handler so a thread death is logged and counted.
- **Add a test that fails when a cached class changes without a version bump**, or move to a serializer with tagged fields.

The boundary catch is where review got interesting. The simple version is `catch (Throwable t)`. It catches this incident. It also catches `OutOfMemoryError` and `StackOverflowError`, which mean the JVM itself may be in a state where carrying on is unsafe. Reviewers argued for catching only the linkage family and letting VM errors propagate:

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

My view: the narrow catch is right only together with the handler. Without one, the next unlisted error type reproduces this incident. And a handler fires only for work started with `execute()`; `submit()` stores the failure in a `Future` nobody reads.

The cache-read catch is weaker than it looks: a mis-decoded object can survive the read and fail elsewhere. The versioned key stops a wrong object being returned at all; the catch is the second line of defence.

**Lessons:** version anything you serialize into a shared store, including the key. Catch everything that means "this record is bad" at the worker boundary, and report everything else. Alert on "started but not finished after T", because a failure that never reports itself can only be found by noticing what is missing.

---

## 3. Retries under a slow database

### The policy

Ingestion looks up the meter and the customer for each group of readings before it writes, so a slow database is felt immediately. The retry policy is short and readable:

- **Transient** means a database-driver error or an I/O error anywhere in the cause chain. Anything else is rethrown at once.
- **Five attempts** in total, with exponential backoff starting at one second: sleeps of 1, 2, 4 and 8 seconds, about 15 seconds of added wait per failing call.
- The sleep is a plain `Thread.sleep` **on the worker thread**. The code comment justifies it as safe because ingestion is single-threaded per record.
- **After exhaustion** the record group is not dropped silently. It is written to the error file with a generic unknown-internal-error code, a transient-retry-exhausted metric is published, and the loop moves on to the next customer.

Each part is defensible on its own. Together they behave badly in exactly the situation retries exist for.

### Backoff holds pool threads

The comment is correct about one record and wrong about the pool. A sleeping thread holds a pool slot and an executor permit. When the database is slow for everyone, every thread is likely sleeping at once, and the pool's useful capacity drops just as the backlog grows.

The worst-case arithmetic, as an assumption: the database driver's request timeout is 10 seconds. If that applies to each attempt, one call to an unresponsive database costs:

```
5 attempts × 10 s timeout   = 50 s
4 sleeps   (1+2+4+8)        = 15 s
                              ────
                       ≈ 65 s per call
```

The policy has no memory across calls. The next customer group in the same chunk starts from attempt one and pays the same 65 seconds. A synthetic chunk with 2,000 customer groups, all failing, takes over 36 hours of one thread's time to fail. Long before then its visibility timeout has expired, and another worker is running the same chunk into the same wall.

### What exhaustion looked like in practice

- **2023.** Two days of enrollment files were not ingested, about 250 customers. The database error mentioned an unavailable token range. Downstream, every reading and bill line for those customers was rejected as "user does not exist", which produced hundreds of thousands of errors on the utility's side. The utility found the gap from its own error report before the platform's monitoring did.
- **July 2026.** An ingestion worker stalled for more than an hour on enrollment files, logging repeated "session is closed" database errors.
- **November 2026.** Database read timeouts on a lookup. Records failed after all retries and were skipped, so enrollments and updates in those files were not applied.

Skip-and-continue is the right default for a bad record and the wrong one when *every* record fails for the same infrastructure reason: one outage becomes thousands of permanent errors, reported with the same code as a bug. Enrollment failures also cascade into every later file for those customers.

### Recommendations (my analysis, not current behaviour)

- **A retry budget.** Cap total retry time per chunk, not just attempts per call. When the budget is spent, stop retrying.
- **A circuit breaker per dependency.** After a run of exhausted calls, open the breaker: fail the *chunk*, leave the message undeleted, and let the queue redeliver it after the database recovers. Records are not skipped one at a time into the error file. Upserts make the redelivery safe.
- **Jitter**, so workers do not retry in lockstep against a recovering database.
- **A distinct error code** for "infrastructure exhausted", with a replay path.
- **Adaptive concurrency**: when latency rises, call the database from fewer threads instead of keeping them all asleep.

**Lesson:** a retry policy decides what happens *after* the last attempt. If the answer is "skip", make sure the skip is distinguishable, counted and replayable.

---

## 4. Ordering between dependent files

Some files depend on others. An enrollment file creates customers. A preference file sets their communication preferences. Process the preference file first and every line fails with "user does not exist".

There is a gate for exactly this. A listener checks whether any file of an earlier-ranked type is still waiting, and if so it does not read from the queue. The flaw was where the check sat:

```
09:59:55.0  gate: no earlier file pending  ✔
09:59:55.0  long poll starts (up to 20 s)
10:00:00.0  enrollment file lands
10:00:00.9  preference file lands
10:00:01    poll returns the preference message
            processed without re-checking the gate
            → "user does not exist" for every line
            → message deleted as processed; never retried
```

*(Times synthetic; the 0.9-second gap and the 20-second poll are from the real case.)*

A preprocessor wrote the two files about 0.9 seconds apart. That is a check-then-act race across a 20-second wait. It is not specific to one customer: any utility that drops both files close together can hit it. The result was customers silently missing their subscription preferences.

### Defer, don't fail

The fix direction re-checks the gate **after** a message is received. If an earlier file is still pending, the listener does not process the message and does not delete it. The queue redelivers it after the visibility timeout. Waiting moves from an in-memory loop to the queue, which already knows how to hold work and survives a restart.

Two costs come with that:

- **"Not yet" lasts a full visibility timeout**, not a few seconds. For files that arrive daily, that is fine.
- **The check is not free.** It lists object storage for each earlier-ranked type, and now it does so per received message. That load needs measuring before it goes everywhere.

A message deferred often enough will reach the max-receive count and land in the dead-letter queue. If an enrollment file is stuck, that is where its dependants should end up, as long as it is intended.

**Lesson:** "not yet" and "never" need different answers. A dependency failure should defer; only a data failure should reject.

---

## 5. Fan-out: one event, many messages

Every ingested upload raises downstream work: an aggregation request for the customer and, depending on configuration, a disaggregation request. The time range comes from the upload event, so volume scales with *events × range*.

Fan-out is also where idempotency is thinnest. The source message is deleted only after both downstream messages are published. If the second publish fails, redelivery publishes the first one again. Each duplicate is harmless, because aggregation recomputes from stored data. The *count* is not harmless.

### Two floods

- **Test environment.** A thirteen-month solar backfill produced about 280,000 aggregation messages. It kept producing them while the file was processed, triggered intermittent reprocessing, and blocked other testing in that environment. A code change fixed it.
- **Production, 2026.** The main aggregation queue reached about **12 million messages**. Throughput fell to around 500 messages per five minutes. Normal is two to three million a day. The suspected cause was a daily customer-update file in which every rate-plan change triggered an aggregation, from a customer who was not routed to its own queue group.

The arithmetic shows why it was not going to drain itself:

```
backlog            12,000,000 messages
drain rate         ~500 per 5 min  = ~144,000 per day
time to drain      12,000,000 / 144,000 ≈ 83 days
                   (plus whatever arrives meanwhile)
```

### Drain, purge, or replay

| Option | What it does | Safe when |
|---|---|---|
| Drain | Let workers process the backlog | Rate × time is acceptable and the work is still wanted |
| Purge | Delete everything in the queue | Every message can be regenerated, for every tenant on it |
| Replay / redrive | Re-send parked messages | The messages are still correct and the cause is fixed |
| Targeted delete | Remove one tenant's messages only | That tenant's work is redundant and can be regenerated |

Draining would take months. A purge would destroy every *other* customer's messages on the queue. Redriving would recreate the flood. The decision was to delete the flooding customer's messages, not redrive them, and change routing separately. That needed a targeted drain tool that removes one customer's messages and leaves the rest. Aggregation messages say "this customer needs recomputing", not the data itself, so deleted work can be recreated deliberately.

**Lesson:** coalesce fan-out per customer per file, give backfills their own lane, and build the per-tenant delete tool before you need it, because "purge" is the only button most queues come with.

---

## 6. Tenant isolation: the 48-hour neighbour

Aggregation queues are partitioned by group. A routing file maps tenants to groups, and each group gets its own queue and consumers. Tenants not in the file share the default queue.

In September 2026 two customers' workloads shared one group. Processing for thousands of one customer's accounts was delayed **more than 48 hours**. There were zero errors in the logs. The fix, shipped as a hotfix, was a dedicated partition.

- **Autoscaling watched depth, not age.** Scaling alarms read the visible message count, averaged over minutes. A slow, steady starvation stays under any depth threshold that a healthy backfill is allowed to exceed. In-flight messages are not counted at all.
- **The age metric measures the past.** The code stamps each message when it is sent and records time-to-receive in buckets, from under a second up to more than three days. That is age *at dequeue*. A message nobody is reading produces no data point until somebody reads it. It measures drain lag, not the age of the oldest waiting message, so it reports a starvation only after it ends.
- **Fairness is configuration.** Routing is read once per process and changes only with a deploy, so emergency isolation is a release, not a switch. If the routing file is missing or unparseable, the router logs one error and sends every tenant to the default queue, and every grouped queue goes quiet and looks healthy.

Little's law (a general queueing result, not a measurement) says why depth misleads: wait ≈ depth ÷ throughput. Flat depth with falling throughput means rising wait, and no depth alarm will see it. Synthetic: 800 messages waiting, throughput falling from 400 a minute to 20 a minute, means the wait grows from 2 minutes to 40 with depth unchanged.

**Lesson:** alarm on the age of the oldest message, per tenant group, and treat a fallback to the default route as an incident, not a log line.

---

## 7. Scaling needs prerequisites

"Add more machines" assumes that work can be split and that two machines will not do the same work. An internal analysis of the file-pickup layer found neither was true.

### The 140-to-3 choke point

```
queues = customers × file types
  │  ~1 listener thread per queue
  ▼
listener pool: ~140 threads ──► semaphore ──► task pool: 3 threads
```

Adding listeners meant more threads competing for three permits: more contention, no more throughput. The SFTP path had one thread per customer, listing each file type in turn every five minutes, so throughput was bounded by customer count, not by work. And every install started every daemon and cron job, so scaling one role scaled all of them.

### The proposed design, and what it depends on

The direction (proposed, not shipped) has four parts:

1. **Role-based start flags**, so pickup, chunking and processing scale independently.
2. **Distributors that partition work**, using a consistent hash of customer and file type into N shard queues.
3. **Single ownership** of each file, through a lock keyed on customer, file type and file name with a TTL and explicit release, or through deterministic partitioning.
4. **An idempotency key per file**, with lifecycle states (received → chunking → chunked → uploaded). A duplicate is acknowledged as a no-op.

The design's working assumption, listed as an open question, is that "at-least-once plus idempotent is likely sufficient". I agree. The risks are where the work is:

- **Lock TTL.** Too short gives duplicates from a slow owner; too long stalls a file behind a dead one. A lock is a lease, and the idempotency key makes an expired lease survivable.
- **Listing load.** More pickup workers mean more listing connections, which can overload the SFTP server.
- **Ordering versus the shard key.** Enrollment and preference files for one customer have different file types, so hashing customer *and* file type can put them on different shards, and the section 4 gate must then work across shards. Sharding on customer alone keeps them together, at the cost of a hot shard for a large customer. The design lists ordering as a constraint the shard key must preserve; that constraint decides the key.

**Lesson:** partitioning, single ownership and idempotency come before scale-out. Without them, more machines means more contention and more duplicate work.

---

## 8. The unit of rejection

When part of an input is bad, what do you reject? The answer differs by data type, and it should be a decision rather than an accident of where a `catch` block sits.

- **Raw readings: the row.** Bad rows go to the error file, and good rows in the same chunk are written.
- **Invoices: the bill.** An invoice arrived with twelve line items. Two were invalid: one had a blank consumption or cost, the other an invalid charge type. The parser failed fast and rejected all twelve lines with an "invoice not processed" error. The customer held its go-live. The team's position was that the behaviour is correct and that the utility should send valid values, and the ticket was closed.
- **Configuration failures: the chunk.** If the file cannot be interpreted at all, the chunk fails.

The invoice case looks harsh, but the reasoning holds. A bill is a total. Ingest ten of twelve lines and the stored bill has a plausible, wrong amount, which nothing flags. The cost is a visible blast radius: ten valid lines come back with the same error as the two bad ones. With document-level rejection, the report should say *which* lines caused it.

**Lesson:** choose the unit of rejection per data type, write it in the onboarding contract, and make the error report point at the cause, not just the casualties.

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

None of these makes a pipeline fail less. They make sure that when it fails, the work ends up somewhere you can see it, explain it and replay it.
