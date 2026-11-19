---
title: "Every Record Accounted For"
subtitle: "How to tell whether a smart-meter file actually made it through ingestion"
slug: every-record-accounted-for
date: 2026-11-20
status: published
tags: [data-engineering, reliability, ingestion]
---

Here is a file with two meter readings in it. Both pass validation. Both are written successfully. The pipeline reports *2 records ingested, 0 failed*.

Storage holds one row.

Would you sign off on that file?

I spend a lot of my time on a version of that question. The utility-analytics platform I work on [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters, most of it delivered by utilities as batch files. My part is narrower than the platform: when we onboard a utility, I help answer two questions about one file at a time.

- **Before upload:** does this file match what the pipeline has been configured to expect?
- **After upload:** what evidence do we have about what happened to its records?

I built a tool for each. This post is about what those tools can tell you, and, more usefully, where their evidence stops.

---

## Before upload: should we send this file at all?

The preflight check reads a partner's file and compares it with the ingestion configuration it will meet. It does not ingest anything. It answers one question: *if we upload this, will the pipeline read it the way we think it will?*

The checks are unglamorous, and that is the point:

- **Does the file name map to the file type we expect?** On one entry path, the type comes from a prefix in the file name. A file with a plausible-looking but wrong prefix is not rejected loudly; it is simply not picked up.
- **Is the delimiter consistent, and are rows as wide as the configuration's largest field position?**
- **Are mandatory fields present?**
- **Do the dates match the configured format?** `2026-03-08` and `03/08/2026` are the same day to a person, not to a parser.
- **Does the interval between readings match the configured granularity?**
- **Does the first line look like a header** that the pipeline would try to read as data?

In one onboarding run, the check passed four test files that we knew had ingested cleanly, and flagged two generated files whose dates used a different format from the one the pilot expected. That second result is the useful one: it is much cheaper to find a date-format mismatch before a file enters a pipeline that writes to several stores than after.

The tool's documentation ends with a sentence I now try to apply to every check I write: **a pass confirms only the checks that ran.** Preflight does not validate time zones, units or semantic correctness. It tells you the file is readable as configured, not that its contents are right. Keep that limit in mind; it matters later.

---

## After upload: what actually happened?

After a file is uploaded, the pipeline splits it into chunks, and each chunk writes audit milestones as it moves: read, filtered and transformed, ingested, sent for reporting. The milestones carry counts: lines read, records that failed transformation, records ingested, records that failed ingestion.

The post-upload audit gathers those milestones for one file and turns them into a verdict:

| Verdict | Meaning |
|---|---|
| `INGESTED_OK` | Every chunk reached "ingested" with no failed records |
| `INGESTED_WITH_FAILURES` | Ingested, but some records failed; the counts are shown |
| `IN_PROGRESS` | Not finished, and the last step is recent |
| `STUCK` | Not finished, and the last step is older than a grace period; the last step is named |
| `NOT_FOUND` | No audit rows for this file |

It also shows the depth of the relevant queues, and how old the newest audit row is.

That last line matters more than it looks. The audit trail reaches the analytics store with a lag, sometimes of many hours. A file with no audit rows can look like a file that has vanished, when the evidence simply has not arrived yet. So `NOT_FOUND` never stands alone. If the audit stream is stale, the tool says so: *the stream may lag; the file can still be ingested*. If the stream is current and there is still nothing, it says that instead: *the file did not start, or the name differs*.

Those are different situations with different next steps, and a tool that merges them into "missing" sends people in the wrong direction.

---

## The gap: two successful writes, one row

Now back to the opening file. Here are its two readings, as a partner might send them on the night the clocks go back:

| Source timestamp | Reading |
|---|---|
| `2026-11-01 01:30 −04:00` | 0.42 kWh |
| `2026-11-01 01:30 −05:00` | 0.57 kWh |

*(A synthetic example, but a realistic one.)*

These readings are an hour apart. If the pipeline keeps the offset, or converts to UTC correctly, they get two different keys and two rows.

If the offset is lost somewhere, for example because the partner sends local time only, both readings become `01:30` and map to the same instant. Interval data is usually stored by meter and timestamp, and each write is an upsert. The second write replaces the first.

Nothing failed. Each write succeeded. The audit milestones say 2 read, 2 transformed, 2 ingested, 0 failed. My tool reports `INGESTED_OK`.

And it is right, about what it measures. Both inputs were processed. What it cannot say is that both readings **survived**, because it never looks at the destination. It reads the pipeline's account of its own work, not the stored data.

Preflight would not have caught this either. Its documentation says so: no time-zone validation. Two honest tools, both green, and a missing reading.

So the accurate sentence after `INGESTED_OK` is:

> Both inputs were processed. To confirm that both readings were stored, I need a check against the destination.

That sentence is less satisfying than "the file is fine". It is also the only one I can defend.

---

## Why the pipeline is built this way anyway

It would be easy to read the example above as a design flaw. It is closer to a trade-off.

Files get re-sent. Workers crash halfway through a chunk, and queue messages are only acknowledged after success, so the chunk runs again. In a pipeline like that, **retries are normal**, and the reason they are safe is exactly the upsert: writing the same reading twice leaves one row, not two.

The key that makes a retry harmless is the same key that lets two *different* readings collapse into one. You cannot remove that edge by changing the write semantics without losing idempotent retries. You move the defence somewhere else:

- **Make time an explicit part of the contract.** Agree on the time zone and offset rules with the partner during onboarding, write them down, and test with a daylight-saving date.
- **Check the destination, not only the pipeline's counts.** For a sample of meters, compare distinct input keys with stored keys. If two inputs map to one key, that is a finding, even if every write succeeded.
- **Let "unresolved" be a real state.** Counts that do not add up are not automatically "still in flight".

---

## Four outcomes, not two

The mental model I have moved to is simple. After a file runs, every input record should be in one of four states:

1. **Confirmed:** we have evidence it was stored as intended.
2. **Rejected:** the pipeline refused it, and we can say why.
3. **Pending:** we have positive evidence that it is still being processed.
4. **Unresolved:** none of the above.

A healthy pipeline is not one where the fourth bucket is empty because nobody looked. It is one where you can see the size of that bucket, and it is small and explained.

My audit tool, honestly described, moves records into *rejected* and *pending* reliably, and gives strong but indirect evidence for *confirmed*. The opening example is a record it would place in *confirmed* by mistake. Knowing that is more useful than not knowing it.

---

## So, would I sign off?

Back to the file with two readings and one row.

With only the pipeline's report, I would say: *processed, 2 of 2, no failures*. That is true, and it is not the same as *stored, 2 of 2*. If the file arrived on a daylight-saving date, or from a partner whose time-zone rules we have not confirmed, I would not sign off on counts alone. I would check the destination keys for that window first.

At scale, it is tempting to treat a green job as a correct result. Most of the time it is. The engineering work is in knowing which questions a green job answers, which ones it does not, and building the next check exactly where the current evidence stops.
