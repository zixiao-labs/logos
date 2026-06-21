# @logos/collab — CRDT Collaboration Engine

Real-time, offline-friendly collaborative editing for the Logos editor.

The engine is built on a **CRDT (Conflict-free Replicated Data Type)** for text, ordered by a
**Lamport (logical) clock**. The core is implemented as a **native module in Rust, exposed to
JavaScript through [NAPI-RS](https://napi.rs/)** — deliberately **not** on top of [Yjs](https://github.com/yjs/yjs).

This document explains that choice. The short version: **for the document sizes, edit rates, and
latency targets a code editor cares about, a pure-JavaScript CRDT runs into the V8 garbage
collector and boxed-object overhead long before the algorithm itself is the bottleneck. A compact,
GC-free Rust core removes that ceiling.**

---

## Why a CRDT (and a Lamport clock) at all?

Collaborative text editing needs every replica to converge to the same document regardless of the
order in which concurrent edits arrive, with no central server arbitrating order.

- **CRDT** gives us *convergence by construction*: operations commute, so applying the same set of
  edits in any order yields the same text. This is what makes the editor work offline and over
  lossy / peer-to-peer transports — there is no "rebase" or merge-conflict step.
- **Lamport clock** gives a cheap causal ordering (a monotonic counter per replica, advanced on
  send/receive) so concurrent insertions at the same position get a deterministic, stable tie-break
  across all peers without wall-clock synchronization.

This is the same family of techniques behind Zed's collaboration, `diamond-types`, and
`automerge` — see *Design inspiration* below. We treat those as inspiration, not as benchmarks we
claim to have matched.

---

## Why **not** Yjs?

Yjs is excellent, mature, and battle-tested, and we owe its design a lot. Our objection is **not**
correctness or features — it is the **runtime cost of running a fine-grained CRDT inside V8** at the
scale a code editor reaches (large files, long edit histories, fast keystroke streams, multi-cursor
agents). The relevant costs:

1. **Garbage-collector pressure.** A CRDT represents the document as many small structural records
   (one per inserted run/item, plus deletion markers / tombstones). In JS these are heap objects.
   Millions of them over an editing session mean sustained allocation and major-GC pauses — the
   classic source of input-latency jank that you cannot fully tune away from inside the language.

2. **Boxed numbers and pointer-chasing layout.** Lamport timestamps, client IDs, and clocks are
   numbers; in JS they live as boxed `double`s inside objects scattered across the heap. Walking the
   op-log or the item store is a cache-miss-heavy pointer chase rather than a scan over contiguous
   memory.

3. **Single main thread.** A heavy merge, a large history replay (e.g. opening a document with a
   long edit history), or an integrity / GC pass happens on the same thread that paints the editor.
   There is no clean way to move it off without serializing the whole doc across a Web Worker
   boundary, which reintroduces copy cost.

4. **Memory bloat of the doc + update log.** Tombstones and per-item metadata inflate resident
   memory; the encoded update stream, while compact, is still produced and consumed by JS.

5. **No SIMD, JIT warmup, and unpredictable inlining.** The hot paths (binary search over the item
   list, run-length integration, encode/decode) are exactly the kind of tight numeric loops that
   benefit from SIMD and predictable codegen — neither of which JS reliably gives you.

None of these are *bugs* in Yjs; they are properties of doing this work in a managed,
single-threaded language. They set a performance ceiling that we want to be above.

---

## Why a native Rust core via NAPI-RS

A Rust core addresses each point above directly:

- **No GC.** Ownership / borrowing means deterministic deallocation and no stop-the-world pauses —
  the single biggest win for keystroke-latency predictability.
- **Compact, contiguous memory.** The document is stored as a rope / range tree with
  **run-length-encoded** operations (long runs of sequential inserts collapse to a single record),
  and clocks / IDs are packed primitive fields. This is cache-friendly and shrinks resident memory
  versus one-object-per-character approaches.
- **Off-thread heavy work.** Large merges and history replay run on a Rust thread pool (via
  NAPI-RS's async tasks) without blocking the renderer.
- **Zero-copy across the boundary.** NAPI-RS lets us pass encoded updates as `Buffer` / typed-array
  views backed by Rust-owned memory, so syncing a change to / from the editor doesn't deep-copy the
  payload into the JS heap.
- **SIMD & predictable codegen.** The integration and encode / decode loops can use explicit SIMD
  and benefit from LLVM's optimizer; no JIT warmup.

### What about `yrs` (the Rust port of Yjs)?

`yrs` is a legitimate option and shares most of the above advantages over JS Yjs. We keep the door
open to backing our core with `yrs` rather than a fully bespoke CRDT. The decision recorded here is
the **language / runtime boundary** (native Rust + NAPI-RS, not JS Yjs); whether the Rust side is a
purpose-built rope-CRDT or `yrs` is an implementation detail we can revisit against benchmarks. A
bespoke core is justified only where editor-specific needs (Monaco range mapping, our exact wire
format, agent-driven bulk edits) make a tailored data layout meaningfully faster.

---

## Honest trade-offs

Going native is not free:

- **Build & toolchain complexity.** A Rust toolchain is required to build, and we ship **prebuilt
  binaries per platform / arch** (macOS arm64 / x64, Windows x64, Linux x64) via NAPI-RS so end
  users don't compile anything. That prebuild matrix is real maintenance.
- **Debugging across FFI.** Stack traces stop at the boundary; reproducing a bug may mean dropping
  into a Rust debugger.
- **Distribution size & loading.** A native `.node` addon must be unpacked from the app bundle
  (cf. the `asarUnpack` entries used for other native deps in this repo).
- **Ecosystem.** Yjs has a large ecosystem of providers (y-websocket, y-webrtc, IndexedDB
  persistence, editor bindings). By going native we give that up and own more of the stack. We
  consider this an acceptable cost for the latency / memory headroom — and providers / transport are
  **out of scope** for this package anyway (see Architecture).

We adopt the native path **because the performance ceiling matters more to us than the
convenience**, and because the prebuild / distribution cost is one we already pay for other native
modules in Logos.

---

## Architecture (sketch)

```text
        ┌─────────────────────────── Rust crate (collab-core) ────────────────────────────┐
        │  rope / range-tree document  ·  RLE op-log  ·  Lamport clock  ·  encode/decode    │
        └───────────────────────────────────────────────────────────────────────────────────┘
                                          ▲  #[napi] bindings (NAPI-RS)
                                          │  zero-copy Buffers, async tasks
        ┌──────────────────────────────── thin TS facade (this package) ──────────────────────┐
        │  Doc / Text handle  ·  applyLocal(delta)  ·  applyRemote(update)  ·  onChange()        │
        └───────────────────────────────────────────────────────────────────────────────────────┘
                                          ▲
                                          │  maps Monaco model edits ⇄ CRDT ops
                                     Logos editor (Monaco)
```

- **Rust crate** owns the CRDT, the Lamport clock, and the op-log; it produces / consumes compact
  binary updates.
- **`#[napi]` bindings** expose a minimal surface and pass updates as zero-copy buffers; heavy
  operations are async tasks off the render thread.
- **TS facade** (the public API of this package) adapts Monaco `IModelContentChangedEvent`s into
  CRDT operations and applies remote updates back into the model.
- **Transport / sync is intentionally out of scope here.** This package is the *engine*; how updates
  travel between peers (WebSocket, WebRTC, server relay) lives elsewhere.

---

## Benchmarking intent (methodology, not numbers)

We do **not** publish performance numbers yet; claiming specific figures without a reproducible
harness would be dishonest. When we do, we will measure:

- **Apply throughput** — local ops/sec for single-char and bulk (paste / agent) edits.
- **p50 / p99 apply latency** — the tail matters most for typing feel.
- **Memory per 1M edits** — resident memory after a scripted million-edit session, including
  tombstone overhead.
- **History replay** — time to load a document with a long edit history.
- **GC behavior** — pause counts / durations on the JS side (expected: near-zero attributable to the
  CRDT, since the document lives in Rust).

Each will be run head-to-head against a JS-Yjs baseline on identical edit traces, on the prebuild
target platforms.

---

## Design inspiration (not claimed parity)

- **Zed** — Rust-native collaborative editing; the bar we admire for editor-grade latency.
- **`diamond-types`** (Seph Gentle) — RLE / rope CRDT techniques and benchmarking discipline.
- **`automerge-rs` / `yrs`** — production Rust CRDT cores and their NAPI / WASM binding patterns.

These informed the *design*; any comparison to them is aspirational until our benchmark harness says
otherwise.
