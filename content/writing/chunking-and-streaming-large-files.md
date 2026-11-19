---
title: "Chunking and Streaming a Multi-Gigabyte File Without Running Out of Memory"
subtitle: "Memory budgets, chunk sizes, formats that refuse to stream, and why the error path needs a budget too"
slug: chunking-and-streaming-large-files
date: 2026-11-23
series: every-record-accounted-for
part: 1
status: published
tags: [data-engineering, ingestion, streaming, jvm, memory, reliability]
---

A partner sends a file. It is encrypted, maybe compressed, and holds a few gigabytes of meter readings. The process that picks it up has a fixed heap. Any part of the file can fail, and any part of the work may run twice.

You cannot hold the file in memory, so you cut it into pieces, and every piece then needs its own status, retry and error trail. You also have to audit every other buffer in the process, because the code that reads the file is not always the code that runs out of memory.

The platform I work on [publicly reports](https://www.bidgely.com) processing about a terabyte of data a day from tens of millions of smart meters, mostly as files. The [overview post](/writing/every-record-accounted-for) follows one file through a pipeline of that kind. This one stays on arrival and chunking, and on the error path, where a carefully chunked pipeline can still run out of memory. The designs and numbers below are generic or made up for illustration.

---

## 1. Where a file goes before any type-specific logic runs

A typical arrival path has two entries. A pickup daemon polls SFTP and local landing folders on a short interval, decrypts and unpacks what it finds (PGP, GZ, ZIP), and uploads the result to object storage. On the second path, an object-storage upload event goes onto a queue, and a worker from a bounded thread pool consumes it. The file type is usually parsed from the file name.

```
 partner SFTP / local landing          object storage upload
          │ poll                                │
          ▼                                     ▼
 ┌──────────────────────┐            upload event → queue
 │ pickup daemon        │                       │
 │ decrypt · unzip ·    │                       ▼
 │ gunzip · upload      │──────────▶  worker (bounded thread pool)
 └──────────────────────┘                       │
          ┊                                     ▼
          ┊ (optional, in parallel)      ┌──────────────┐
          ▼                              │   chunker    │
 audit counter: decrypt,                 └──────┬───────┘
 count records, write                           │ chunk N + metadata file N
 a pre-ingestion count                          ▼
                                   per-chunk processing (parse → validate →
                                   transform → look up → write)
                                                │
              ┌─────────────────┬───────────────┼──────────────┬──────────────┐
              ▼                 ▼               ▼              ▼              ▼
        chunk status      failed lines     completion     audit events      metrics
        (status store)  (object storage)  event (queue)   (warehouse)
                                                │
                                                ▼
                                  reporter: collect failed lines,
                                  build the partner's error report
```

Two things in that picture matter for memory.

First, an optional audit step reads the *same* file in parallel, decrypts it and counts its records. Every independent reader of a large file is another place that must not hold the whole file in memory.

Second, a single file touches several stores before any type-specific logic runs, and then fans out further by type. A customer-profile file may write several related records to more than one store; an interval-data file writes readings and triggers downstream jobs. Each of those writes holds state while in flight. The chunk is what keeps all of that state bounded.

---

## 2. A chunk is a unit of work, of retry, and of evidence

The chunker splits a file into chunks, with the size configured per file type. Each chunk is uploaded separately, together with a metadata file that lists, for each record, its line number and the original file name. That is how a failed record deep inside a late chunk can still be reported to the partner by its line in the original file.

Each chunk also gets a status, and so does the file. A design like this ends up with several states across two levels: file-level ones (started, failed, empty, complete) and chunk-level ones (queued, processing, done, failed). The overview lists the chunk-level ones. The file level matters just as much, because the chunker can fail before any chunk exists. **If a design only tracks chunks, a file that never produced one leaves no trace at all.**

I treat the chunk as the carrier for evidence, not just for work. Status, line numbers and failed lines all hang off it. If chunking is wrong, everything downstream reports on the wrong unit.

---

## 3. Two ways to cut a file

### Read everything, then slice

The simplest chunker reads every line of the decrypted file into an in-memory list. It wraps each line in a small record (line number, file name, data), computes chunk boundaries as index ranges over that list, and writes each chunk as a slice of it. It can also register the status of every chunk in one call before the first upload, so the status store says "all chunks" before any of them exists.

In that design every row of the file is in memory at once, and each row pays for two layers of objects: the line in the list, and the record wrapper around it.

It has real advantages. You know the total record count before you start, boundaries can be computed with full knowledge of the file, and the rest of the pipeline gets a complete picture early. The cost is that **peak memory is proportional to file size**: fine for a typical daily file, dangerous on the day someone sends thirteen months of history.

### Stream, chunk by chunk

A streaming chunker reads one chunk's worth of lines, registers that chunk, uploads it with its metadata, writes an audit record, publishes a metric, and moves on. For PGP-encrypted files it decrypts as it reads, so the plaintext never exists as a whole. Only after the last chunk does it write the file-level total and mark chunking complete. If the file yields no chunks at all, it is flagged as empty.

Peak memory is roughly one chunk of lines plus their wrappers. The shape, as a sketch written for this post:

```java
// Illustrative only.
try (BufferedReader in = openDecryptingReader(source)) {   // decrypt on read
    List<String> batch = new ArrayList<>(chunkSize);
    int chunkNo = 0;
    long firstLine = 1, lineNo = 0;
    String line;
    while ((line = in.readLine()) != null) {
        lineNo++;
        batch.add(line);
        if (batch.size() == chunkSize) {
            emitChunk(chunkNo++, firstLine, batch);       // register, upload, audit
            batch = new ArrayList<>(chunkSize);           // drop the old reference
            firstLine = lineNo + 1;
        }
    }
    if (!batch.isEmpty()) emitChunk(chunkNo++, firstLine, batch);
    if (chunkNo == 0) markEmptyFile(source);
    else markChunkingComplete(source, lineNo, chunkNo);   // totals known only now
}
```

Streaming changes the failure semantics as well as the memory profile. In the read-everything design, a mid-file failure happens before or between uploads of chunks that were all registered in advance. In the streaming design, a failure at chunk 300 leaves chunks 0 to 299 registered and uploaded, and the file-level total was never written. Neither is wrong, but they produce different evidence, and whatever reconciles "what arrived" against "what was processed" has to understand both.

### Make the safe path the default

If both designs exist and the streaming one has to be switched on, memory safety becomes a property of a configuration rather than of the system: the same large file is safe under one setting and fatal under another. **If a safe path exists, it should be the default, and the unsafe path should be the exception someone has to justify.**

---

## 4. A memory budget, worked through

It helps to write the budget down. The numbers below are **synthetic**, chosen to be plausible for a JVM worker.

**The file.** 2 GB of decrypted CSV, 10,000,000 rows, about 200 bytes per row.

**Read everything into memory.** With compact strings and compressed references, each line costs roughly:

| Item | Approx. bytes |
|---|---|
| `String` object header and fields | 24 |
| backing `byte[]` header | 16 |
| 200 characters, one byte each (Latin-1) | 200 |
| list slot (reference) | 4–8 |
| record wrapper (header, line number, two references) | ~32 |
| **Per row** | **~280** |

10,000,000 rows × 280 bytes ≈ **2.8 GB**, before a single row is parsed. The text alone is 2 GB, so the JVM overhead adds about 40%. Any non-Latin-1 character in a line doubles that line's byte array. Garbage-collector headroom on top of this means a heap of 4 GB or more just to *hold* the file.

**Stream it instead.** Take a chunk of 5,000 rows:

```
raw chunk          5,000 × 280 B            ≈   1.4 MB
parsed working set raw × 5 (objects, maps,  ≈   7   MB
                   lookups, write batches)
per worker thread  1 chunk in flight        ≈   7   MB
16 worker threads  16 × 7 MB                ≈ 112   MB
prefetched msgs    10 × small message       ≈   negligible
caches             fixed size, say          ≈ 300   MB
baseline JVM       code, libraries, etc.    ≈ 200   MB
-----------------------------------------------------------
steady state                                ≈ 0.6  GB
```

The general form is:

```
heap ≥ baseline
     + threads × chunks_in_flight_per_thread × working_set(chunk_size)
     + prefetch × message_size
     + bounded caches
     + Σ (every buffer whose size depends on the input)   ← must be zero
```

Every term but the last is set by configuration: thread count, chunk size, cache size. The last term is set by whatever the partner sent, and **a budget is only a budget if that term is empty.**

---

## 5. Choosing a chunk size

Chunk size looks like a tuning knob. It is really a trade between three costs that move in opposite directions: fixed overhead per chunk, the cost of retrying one, and memory per worker.

| | Small chunks (hundreds of rows) | Medium chunks (thousands) | Large chunks (hundreds of thousands) |
|---|---|---|---|
| Fixed overhead | High: one queue message, one status row, one metadata file, several object writes *per chunk* | Moderate | Low |
| Retry cost | A few hundred rows re-run | A few thousand rows re-run | Hundreds of thousands re-run; a poison record near the end repeats almost everything |
| Memory per worker | Tiny | Small, predictable | Large; working set × threads can dominate the heap |
| Parallelism | High, but overhead may dominate | Good | Few chunks per file; one slow chunk sets the file's finish time |
| Error document per chunk | Tiny | Bounded by chunk | Can itself be large if every row fails |
| Status and audit volume | Very high for big files | Moderate | Low |

Retry cost matters more than it looks, because delivery is at-least-once: a retry rewrites everything the chunk wrote before it failed. Smaller chunks mean less repeated work and a smaller window of partial state.

### Rows, bytes, or cost

There are three ways to express a chunk size, and they answer different questions.

- **Rows** keep the unit of work meaningful, but a row of 15-minute interval data and a row of billing data cost very different amounts to process. That is why the size is set per file type.
- **Bytes** keep memory predictable. A 1,000 KB limit, for example, turns a 10 MB file into roughly 10 chunks. Bytes are honest on the read side and misleading on the processing side.
- **Cost** (lookups, writes, downstream triggers) is what you actually care about. Nobody configures it directly, but it is why per-type sizing exists.

A reasonable rule is to bound chunks by rows for work and by bytes for safety, and to cut at whichever limit is hit first.

### Keep together what must succeed together

A chunk boundary is also a possible failure boundary. If a bill's twelve line items are split across two chunks, and, as the overview post explains, a bill is rejected *as a whole* when any line is invalid, then the two halves can disagree. Chunk A accepts six lines, chunk B rejects the bill, and storage holds half a bill.

The same applies to a meter's readings for one day when a later step computes daily totals, or to a header record and its details in a bundled format. The fix is to make the chunker aware of the grouping key and only cut between groups. That is easy in the read-everything design, which can look ahead freely. In a streaming design it needs a one-group lookahead buffer: keep reading past the target size until the group key changes. That buffer is bounded by the largest group, not by the file, so it fits in the budget as long as you also cap group size and reject absurd groups.

The rule: **the chunk boundary must never be finer than the unit of rejection.**

---

## 6. Streaming end to end, and the formats that refuse

The ideal pipeline is a chain of streams in which no stage materialises the whole input:

```
bytes from storage → decrypt → decompress → parse → group → chunk → upload
     (stream)        (stream)   (stream)    (row)   (row)   (batch) (batch)
```

Partner files can arrive encrypted, compressed, and in many formats: CSV, pipe-delimited, Parquet. Some have headers, some don't, and some are empty. Several of those properties fight the chain above.

### ZIP: the table of contents is at the end

A ZIP archive's authoritative index, the central directory, sits at the *end* of the file. Each entry also has a local header in front of its data, so you can walk the entries forward in order. But a local header may not carry the entry's size (it can be deferred to a descriptor after the data), and only the central directory says definitively which entries the archive contains. A forward reader can disagree with it. Java's `ZipFile` wants random access for exactly this reason; `ZipInputStream` streams, but trusts the local headers.

For a partner archive, the practical choice is between streaming entries forward and accepting that limitation, or spooling the archive to local disk and opening it properly.

### Parquet: the schema is in the footer

Parquet puts its metadata (schema, row-group offsets, column statistics) in a footer at the end of the file. A reader seeks to the end, reads the footer, then seeks back to each row group. It is a random-access format that is very efficient once you can seek.

From object storage, seeking means ranged reads, which works well. From a decrypting pipe there is nothing to seek on, so an encrypted Parquet file must first be decrypted somewhere seekable: local disk or an intermediate object. Budget disk for that copy, not heap.

### Encryption: you learn it was valid at the end

PGP is a stream format and decrypts happily on the fly. The catch is integrity. If the message carries an integrity check at all (an MDC packet or an AEAD tag; some legacy messages have neither), it is verified only after the last byte has been read, and so is any signature. A streaming decryptor has already handed you, and you may already have processed, gigabytes of plaintext before it can tell you the file was truncated or tampered with.

There are two honest designs. Decrypt to disk, verify, then parse: it costs disk and time, but nothing is ingested from an unverified file. Or stream, and treat chunks as provisional until the end-of-stream check passes. What you cannot do is stream into storage and assume the check will pass. Reject messages that carry no integrity check.

### Empty and odd files

Zero-byte files are a format of their own. A 0-byte file that lands next to a valid one must not block it, and it must not vanish either. Flag a file that yields no chunks as empty, so it still leaves evidence of its own.

| Format | Streams forward? | What forces random access or a second pass | Practical approach |
|---|---|---|---|
| CSV / pipe-delimited | Yes | Nothing, unless grouping needs lookahead | Stream; bounded lookahead for groups |
| GZ | Yes | Nothing (CRC at end, like PGP) | Stream; treat output as provisional until end |
| PGP / GPG | Yes | Integrity and signature checked at end | Decrypt to disk and verify, or stream provisionally |
| ZIP | Partly | Central directory at end of archive | Spool to disk, open with random access |
| Parquet | No | Footer holds schema and row-group offsets | Ranged reads on storage, or spool decrypted copy to disk |
| Empty (0 bytes) | n/a | Must not block neighbours | Record explicitly as empty, move on |

The common thread: **when a format needs random access, spool to disk, never to heap.** Disk is cheap and large, and filling it slowly does not take the process down the way a full heap does.

---

## 7. The error path: your largest input on your worst day

### A failure pattern

Here is a pattern I have seen in pipelines like this one, described as a composite. The data path is carefully chunked, yet the process that reports outcomes to partners runs out of heap, and because one reporting process serves many partners, ingestion stalls for partners whose files were fine. The cause is not the data path; it is the error report.

### Why the report grows

At the end of processing, the reporter tells the partner which lines failed. A natural first version does it like this:

```
for each failed chunk:
    load that chunk's errors      ─┐
    add them to one big list      ─┘  → all errors for the file, in memory

format the whole list as text          → full report as one string
encrypt the text into a byte buffer    → full encrypted report in memory
copy the buffer to an array            → a second copy of the encrypted report
upload

repeat for a second copy kept for internal use
```

On a normal day, a file has a handful of failed lines and this costs nothing. Suppose instead a partner sends a file where a wrong date format makes every row fail. Now the error count is the file size, and the reporting path re-assembles every chunk's failures into a single object at the very end.

A **synthetic** calculation shows how quickly that adds up. Take 1,000,000 failed lines at about 200 bytes of report text each:

```
error objects (original line + reason + metadata)   1,000,000 × ~400 B  ≈ 400 MB
report text                                          1,000,000 × 200 B   ≈ 200 MB
encrypted buffer (growing, so briefly larger)                            ≈ 200 MB+
copy of that buffer as an array                                          ≈ 200 MB
second copy for internal use                                             ≈ 200 MB
---------------------------------------------------------------------------------
peak, roughly                                                           ≈ 1.2 GB
```

The exact numbers don't matter. What matters is that several full copies of something proportional to the input are alive at the same time. A bigger heap moves the threshold, but it is still a threshold, and a bad enough file crosses it.

### Isolation shrinks the blast radius, not the buffer

One tempting response is to split the reporter into independent services, one per file type. A bad file of one type would then no longer take down reporting for every other type. But each smaller service would still buffer its whole report and still crash on its own worst file, so isolation is worth having only alongside a bounded buffer, never instead of one.

### Write the report chunk by chunk

The fix is to never hold more than one chunk's errors at a time:

```
open a temp file for the partner report (encrypted stream)
open a temp file for the internal copy

for each failed chunk:
    load that chunk's errors          ← bounded by chunk size
    format just those lines
    write them through the encrypting stream into the partner file
    write them to the internal file
    drop the reference

close both streams
upload both files from disk
delete the temp files (always, even on failure)
```

The encryption still runs on a stream, but the output goes straight to a file on local disk, not into a buffer. The one large object in the process is now the file, and the file is not on the heap. Any I/O error during a chunk write or at the end should close the streams, delete the temp files and fail loudly, naming the file.

If a second consumer needs the same errors, say a stream to an analytics store, give it the same treatment: re-fetch each chunk's errors from storage rather than keeping the first list around. That doubles the storage reads in exchange for a flat memory profile, which is a good trade when storage reads are cheap and heap is not.

### How to test it

Run both versions under a deliberately tight maximum heap, with two inputs: a realistic error file and a synthetic one where every row fails. Record an allocation profile, not just pass or fail. The buffering version's memory grows with the error count until it crosses the heap limit; the streaming version's should stay flat. A version that survives today's realistic file may already be using several times the memory it needs, and the next bad file is the one that decides whether it crashes.

### What "bounded" means here

Bounded is not zero. One chunk's error list is in memory at a time. A chunk cannot have more failed rows than rows, but a row can carry several errors, so the bound is rows per chunk × errors per row; cap errors per row and it is a real bound. The report itself lives on local disk, so the new limit is free disk space, which needs monitoring like any other resource. It is the "spool to disk, never to heap" rule again, reached from the opposite direction.

---

## 8. Everything that grows with the input

Once one input-proportional buffer has bitten you, look for others on the same path.

**Prefetched queue messages.** A queue client that fetches a batch of messages per call and hands them out one at a time keeps the rest in a local cache. If the cache is bounded at the batch size, its memory cost is small. The subtler cost is time: cached messages are invisible to other consumers, and their visibility timers are already running while they wait behind a slow message. Prefetch is a buffer of *time*, not just of bytes.

**Replayed bytes.** A bundled format that carries several record types may be buffered once and replayed to several sub-parsers. Reading once and parsing several times is a deliberate trade, but the buffer is the size of the file, so it belongs in the budget's last line.

**Thread-local caches.** With a fixed pool these are bounded by thread count times cache size, but only if each cache is bounded and cleared between files.

**Logs.** Logging every failed row is an error report you did not design, with the same growth curve.

**Slow dependencies.** "Working set per chunk" is not fixed. When downstream calls slow down, everything a worker holds stays alive longer, and anything that accumulates while waiting accumulates more.

---

## 9. Backpressure: what happens when downstream is slow

A memory budget assumes a fixed number of chunks in flight. Backpressure is what makes that assumption true when the consumer is slower than the producer.

The classic tool is the bounded executor from *Java Concurrency in Practice*: a semaphore around a thread pool. Submitting a task takes a permit and the task releases it when done. When permits run out, submission blocks.

```java
// Illustrative only.
final class BlockingSubmitter {
    private final ExecutorService pool;
    private final Semaphore permits;

    BlockingSubmitter(int threads, int maxInFlight) {
        this.pool = Executors.newFixedThreadPool(threads);
        this.permits = new Semaphore(maxInFlight);
    }

    void submit(Runnable task) throws InterruptedException {
        permits.acquire();                    // blocks the producer when full
        try {
            pool.execute(() -> {
                try { task.run(); } finally { permits.release(); }
            });
        } catch (RejectedExecutionException e) {
            permits.release();
            throw e;
        }
    }
}
```

The value of this pattern is *where* it makes work wait. When the database slows down, permits run out and the loop that pulls from the queue stops pulling. Work stays on the queue, where it is durable, visible and costs nothing in the worker's heap. A pool with an unbounded internal queue would keep accepting tasks and move the backlog into memory, the one place it can kill the process.

Three things weaken that protection.

- **Prefetch sits outside the bound.** Messages already in a local prefetch cache have left the queue, whatever the semaphore says. Keep prefetch small, and make sure the visibility timeout covers the time a message may sit in the cache plus the time it takes to process.
- **Retries hold permits.** If transient database errors are retried with backoff on the worker thread, then during a slowdown many permits are held by sleeping threads. That still bounds memory, but throughput falls just when the backlog is growing.
- **The chunker is a producer too.** A chunker that uploads chunks as fast as it reads them moves the backlog to the chunk queue, which is fine. One that hands chunks to an unbounded in-process pool moves it to the heap.

The rule: **backpressure should push waiting work toward the most durable, most observable buffer you have, and away from the heap.**

---

## Design rules

These are the rules I now check against any design that reads partner files.

1. **Write the memory budget down.** If you cannot fill in every term, you do not have a budget.
2. **The input-proportional term must be zero.** Lists of lines, error lists, report strings, byte buffers, replay buffers, log volume: find them all.
3. **Make the safe path the default.** Streaming should not be opt-in.
4. **Bound chunks by rows for work and by bytes for safety.** Cut at whichever limit comes first; size per file type.
5. **Never cut finer than the unit of rejection.** Use a bounded lookahead and cap group size.
6. **Spool to disk, never to heap.** ZIP directories, Parquet footers, verify-before-parse decryption and large reports belong on disk. Monitor free disk.
7. **Treat streamed output as provisional until end-of-stream checks pass.**
8. **Design the error path for the worst day.** Error count can equal row count. Write reports chunk by chunk to a file; re-read rather than hold for a second consumer.
9. **Test with a tight heap and a file where every row fails,** and read the allocation profile, not just pass/fail.
10. **Let backpressure block the producer.** Semaphore around the pool, small prefetch, a visibility timeout that covers cache time plus processing time.
11. **Leave evidence for files that produce no chunks.**
12. **Know what a mid-file failure leaves behind,** in both chunking modes.

Chunking bounds the work. Only the budget's last line, every buffer that grows with what the partner sent, decides whether the process survives the file, and that line has to be zero on the error path as much as on the data path.

*Views are my own. Examples are simplified or made up and do not describe any specific employer or customer system.*
