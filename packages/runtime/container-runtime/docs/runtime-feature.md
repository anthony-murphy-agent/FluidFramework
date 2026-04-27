# RuntimeFeature framework — design spike

> Status: **design spike, not implementation.** All code is stubbed (`throw new Error("design spike: not implemented")`). The artifact this spike produces is *this document* and the interface surface in `runtimeFeature.ts`.

## Motivation

`ContainerRuntime` is a god-class. Summarizer, garbage collection, ID compression, op compression, staging mode, schema upgrade, pending-state rehydration — all of these are inlined into one ~5,000-line file, gated by config flags on a single options bag (`IContainerRuntimeOptions`). The result:

1. **Code that's "off" still ships.** A read-only viewer that disables summarization still pulls `summaryManager`, `summarizerClientElection`, `summaryDelayLoadedModule`, etc. into its bundle. Tree-shaking can't reach them — they're referenced unconditionally in the constructor.
2. **Adding a feature means editing the constructor.** Pending-state rehydration (the trigger for this spike) wanted to enter staging mode at a specific lifecycle moment. There was no seam to register against, so the implementation grew into the constructor as another conditional branch.
3. **Observability is ad-hoc.** `this.emit("...")` calls are scattered through the class. Lifecycle events (load complete, snapshot loaded, stashed-ops applied) are sealed because there's no framework-level vocabulary for "phase X just finished."
4. **Configs grow indefinitely.** Each new feature adds another field to `IContainerRuntimeOptions`. The bag is opaque — you cannot read it and know what the runtime *can* do.

The proposal: features become opt-in modules registered in a const `Features` registry. Consumers compose configs by adding/removing entries. The runtime engine drives a defined lifecycle and routes hooks to features. Code that isn't in the config isn't loaded.

## Scope of this spike

- **Land:** the framework's interface surface and one feature (summarizer) sketched as a vertical slice. Stubs throw. No engine implementation. No actual code lifted.
- **Use the spike to:** validate the hook surface (does every method on `RuntimeFeatureHost` trace to a real summarizer need?), and identify open questions before committing to a multi-PR refactor.

## Model

```
+--------------------+    +-------------------------+    +-----------------+
| Features (const)   | -> | config object (data)    | -> | engine executes |
|  registry of every |    | user adds/removes/over- |    | lifecycle phases|
|  feature available |    | rides defaults          |    | runs hooks      |
+--------------------+    +-------------------------+    +-----------------+
```

**Three pieces:**

1. **`Features` registry** (`packages/runtime/container-runtime/src/runtimeFeatures/index.ts`). A const object listing every feature the runtime supports. Currently: `{ summarizer }`; eventually: `{ summarizer, garbageCollection, idCompressor, compression, stagingMode, schemaUpgrade, pendingRehydration }`.

2. **Config object.** Plain data describing which features the consumer wants and with what options. Subtractive: `config(Features).without("summarizer")`. Additive: `config({}).with(Features.summarizer)`. The two workflows produce identical objects internally.

3. **Engine.** Receives the config plus loader-supplied context (snapshot, deltaManager, etc.). Topologically sorts features by their `depends` array, calls each feature's `install(host)` once, then drives the lifecycle phases.

## Lifecycle phases

```
construct
  -> loadFromSnapshot
  -> loadPendingAttachments
  -> applyStashedOps
  -> ready
  -> connect / disconnect (repeats)
```

| Phase | Guarantees by end of phase |
|---|---|
| `construct` | All features instantiated; runtime core wired (channel collection); no IO yet |
| `loadFromSnapshot` | Snapshot tree parsed; metadata blob available via host |
| `loadPendingAttachments` | Stashed pending datastore attachments rehydrated |
| `applyStashedOps` | All stashed local ops applied to local DDS state |
| `ready` | Runtime is fully usable; connection has not been initiated |
| `connect` | Inbound op processing started; outbox can submit |
| `disconnect` | Connection lost; submission queued |

The phase set was chosen by walking `ContainerRuntime.loadRuntime2`. Each named boundary survives if a feature actually needs to register a hook there. The summarizer spike used: `loadFromSnapshot`, `ready`, `connect`, `disconnect`. The other phases are speculative and may be culled when other features are sketched.

## Hook surface (`RuntimeFeatureHost`)

Every method on the host traces to a concrete summarizer need. The mapping:

| Host method | Driven by (summarizer) | Predicted future use |
|---|---|---|
| `on(phase, callback)` | All phases above | Every feature |
| `registerOpHandler(type, h)` | summarize / summaryAck / summaryNack | GC ops, schema-change ops |
| `submitRuntimeMessage(type, content)` | Submitting Summarize op | GC submits cleanup ops; schema submits upgrade |
| `getMetadataValue(key)` | electedSummarizerData, summary stats | Schema version, idCompressor seed, GC last-run info |
| `clientDetails` | Election eligibility | Any feature gating on summarizer-vs-interactive client |
| `getQuorum()` | Election | Any feature using quorum-elected client |
| `logger` | Telemetry | Every feature |
| `getDependency(name)` | GC for summary contribution; schema for format | Any feature consuming another |
| `registerSummaryContributor(key, fn)` | **Not used by summarizer** — used by GC, idCompressor, schema | Anything that contributes to the summary tree |

### Hooks deliberately omitted (and why)

- **Direct DDS access.** Features don't get the channel collection. If a feature needs to read state, it goes through `getDependency()` to another feature that owns that state. This forces clean module boundaries.
- **Direct delta manager.** Features can submit/handle ops via `submitRuntimeMessage`/`registerOpHandler`. The delta manager stays internal.
- **Direct quorum write access.** `getQuorum()` is read-only. Quorum writes are runtime-core operations.

## Dependency resolution

`RuntimeFeature.depends` is a `readonly RuntimeFeatureId[]`. Engine behavior:

1. Build the dependency graph from features in the config.
2. Topologically sort. Cycle → throw at startup with the cycle path.
3. Missing dependency (feature lists `feature:gc` but config doesn't include it) → throw at startup.
4. Within a phase, hooks fire in topological order: dependencies before dependents.

Validation runs at engine start, before any IO. Cheap, deterministic, fail-fast.

## Compatibility expectations

`RuntimeFeatureFactory` extends `ContainerExtensionExpectations` (from `runtime-definitions/src/containerExtensionProvider.ts`). The pattern is reused verbatim:

- `hostRequirements: ILayerCompatSupportRequirements` — minimum runtime generation + required runtime capabilities
- `instanceExpectations: { generation, version, capabilities }` — what this feature instance is

Borrowed without modification because it solves the right problem: the engine refuses to install a feature that requires a runtime generation newer than the host. Same problem `ContainerExtension` already solves.

## Coexistence with `ContainerExtension`

| | `ContainerExtension` | `RuntimeFeature` |
|---|---|---|
| Instantiation | Pull (`runtime.acquireExtension(id, factory)`) | Push (declared in config at build time) |
| Lifecycle integration | None — only signal in/out + connection events | Full phase lifecycle (construct → ready → connect/disconnect) |
| Op routing | No | Yes (`registerOpHandler`) |
| Summary contribution | No | Yes (`registerSummaryContributor`) |
| Build-time excludable | No | Yes (whole point) |
| Dependencies on others | No | Yes (`depends`) |
| Replaces built-ins | No | Yes (summarizer/GC/etc become features) |
| Today's tenants | Presence | None yet — spike |

The two systems coexist. Same `ContainerRuntime` hosts both. Presence does not migrate. `ContainerExtension` keeps its current focused role for ephemeral, observational, signal-driven features. `RuntimeFeature` is for foundational runtime subsystems.

## Findings from the spikes

Two vertical slices have been sketched: **summarizer** (first; lifecycle + op routing focus) and **garbage collection** (second; runtime-internal observability focus). Each spike was conducted by walking the existing implementation and listing every runtime capability it touches.

### Findings from the summarizer spike

What we learned by sketching summarizer end-to-end.

### Hooks we knew we needed

- Lifecycle phase callback → trivially required.
- Op handler registration → summarizer needs SummaryAck/SummaryNack.
- Op submission → summarizer needs to submit Summarize.
- Telemetry → every feature needs it.

### Hooks the spike *surfaced*

- **`getMetadataValue`** — surprised me. Summarizer's election state is persisted in document metadata (`electedSummarizerData`). Without this hook, a feature can't reconstitute its state across loads. Likely needed by schema, idCompressor, GC, others.
- **`clientDetails`** — `SummarizerClientElection.clientDetailsPermitElection` decides whether to even bother constructing the election system. The branching feature behavior depends on per-client info that came from the loader.
- **`getDependency(name)`** — feature-to-feature reads. Summarizer reads from GC during summary generation. Without explicit dependency declaration + getter, features become a tangle of imports. With it, the engine validates the graph at startup.
- **`registerSummaryContributor`** — *not used by summarizer*; used by features summarizer collects from. The presence of this method on the host implies the engine has a "produce summary" phase distinct from the load lifecycle. Not in the phase list above; lives on a separate orchestration channel.

### Hooks the spike *removed* (vs initial guesses)

- "On-snapshot-loaded" event with the snapshot tree — too coarse. `getMetadataValue` is the actual need; full snapshot tree access would couple every feature to the snapshot format.
- "On-pending-state" hook — pending-state rehydration belongs to its own feature (`pendingRehydration`), which uses the same `applyStashedOps` lifecycle phase as everything else. No special hook for it.

### Granularity question, unanswered

The summarizer code today bundles four concerns: election, heartbeat, generation, ack-handling. They could be one feature or four. Splitting:

- **Pro:** more orthogonal; a runtime that wants to participate in elections (e.g. for non-summary purposes — there's already `orderedClientElection.ts`) but not summarize is impossible today.
- **Con:** four registry entries instead of one; harder to reason about for the common case.

Spike defers. Revisited after the GC spike (below) — GC does not need election, so the cross-feature case for splitting election out remains weak. Probably keep summarizer monolithic; revisit when a third feature (or an explicit "election as primitive" use case) emerges.

### Findings from the garbage-collection spike

Pushed on a different axis than summarizer: **runtime-internal observability**. Where summarizer is a snapshot-and-respond consumer, GC is a continuous observer of state changes (every node update, every blob upload, every handle binding) that maintains a live reference graph.

#### Validations from existing host surface

- `getMetadataValue` works for non-summarizer features (GC reads `gcConfigs` from snapshot metadata blob).
- `registerOpHandler` works for non-summarizer features (GC handles sweep / tombstone / aborted-sweep ops).
- `registerSummaryContributor` — **first real exerciser**; summarizer surfaced it but doesn't use it. GC contributes its summary subtree via this hook. The contract holds.
- Empty `depends` works cleanly — GC sits at the bottom of the dependency stack with no upstream consumers reachable at install time. Validates that features at the leaves don't require special handling.
- Cross-feature dependency edge **closes the loop**: summarizer's `depends: ["feature:garbageCollection"]` now has a real target. The engine's topo-sort would install GC before summarizer; summarizer's `getDependency("feature:garbageCollection")` would resolve.

#### Hooks GC *surfaced* (not in the framework yet)

- **`dispose` lifecycle phase.** GC has resources to release (timers, telemetry buffers, event subscriptions). Summarizer didn't need this — its state is reconstructible from snapshot. Action: add `dispose` to `RuntimeFeatureLifecyclePhase`. Fires on runtime shutdown, after any final `disconnect`.

- **Node-activity observation.** GC observes channel-collection activity in three distinct shapes:
  1. **Push (event):** `host.onNodeUpdated(handler)` — receive `{ nodeId, type, ... }` whenever a node mutates. Today: channel collection invokes `garbageCollector.nodeUpdated({...})` directly (containerRuntime.ts:1994, 2020, 3826).
  2. **Pull (predicate):** `host.registerNodeFilter("isDeleted", predicate)` — runtime calls back to ask the feature whether a node should be visible. Today: `isNodeDeleted` callback (containerRuntime.ts:1998).
  3. **Walk (visitor):** `host.walkChannelGraph(visitor)` — feature traverses the live reference graph for unreferenced-node detection. Today: dedicated runtime methods like `getGCData()`.

  Open: whether to express these as one generic listenable (`host.events`, like `ExtensionHost.events`), as targeted methods (`onNodeUpdated`, etc.), or as a separate `RuntimeObservationHost` sub-interface that GC-shaped features acquire on demand. The summarizer didn't need any of this; the framework spec must decide whether to cleanly model "feature observes runtime activity" or treat GC as a special case.

- **Async install or async lifecycle hooks.** GC's `initializeBaseState()` (containerRuntime.ts:2259) is async. The current `install(host)` is sync. Either `install` becomes async, or features defer all IO into lifecycle hooks (which already are async-friendly — `on(phase, callback: () => void | Promise<void>)`). The latter is preferred (sync install preserves the "all features installed before any IO" invariant) but only if GC's init can be split cleanly between sync `install` and async `loadFromSnapshot` callback. Not a blocker; flagged for the spec.

#### Hooks GC *did not need* (and that's informative)

- `clientDetails` — GC's election-of-summarizer-client coupling was on the summarizer side; GC itself doesn't gate on client capabilities. Confirms `clientDetails` is summarizer-driven, not universal.
- `getQuorum` — same. Only summarizer uses it.
- `submitRuntimeMessage` from inside `install` — GC submits ops only in response to events (`onNodeUpdated` triggers sweep), not at install time.

#### Confirms hook surface area is right-shaped

After two spikes the host has roughly the right granularity:

- Lifecycle phase callbacks (`on(phase, ...)`) are universal.
- Op routing (`registerOpHandler` + `submitRuntimeMessage`) is shared by features that own op types (so far: 2 of 2).
- Summary contribution (`registerSummaryContributor`) is shared by features that contribute (1 of 2; expected).
- Election-related (`clientDetails`, `getQuorum`) is summarizer-specific (1 of 2). Could be split into a `RuntimeMembershipHost` sub-interface that summarizer acquires; GC compiles without it.

The "everything on one host" approach holds up at N=2, but if a third spike (idCompressor would be a good candidate) doesn't use the membership methods either, it's worth splitting.

## Open questions

1. **Phantom typing of config.** Should `Config<{ summarizer: true }>` produce `Runtime & WithSummarizer` so callers know typed-statically what they have? Phase 2; spike uses runtime checks (feature absent → method throws / returns `undefined`).

2. **Sync vs async install.** `install()` in this spike is synchronous. Some features may need IO (e.g. summarizer reading metadata). Should `install` be `async`, or should features defer IO to `loadFromSnapshot` phase callbacks? Lean toward the latter (sync install, IO in lifecycle hooks) because it preserves a clean "all features installed before any IO" invariant.

3. **`RuntimeFeatureHost` vs `ExtensionHost` — common ancestor?** Both expose telemetry, logger, quorum, audience. Could share a base `RuntimeMemberHost` that both extend. Not done in spike to avoid premature unification; let the second feature confirm the overlap is real.

4. **Removing built-ins.** When a feature is excluded, its absence must be observable to other features that might reach for it. `getDependency("feature:summarizer")` should throw cleanly, not return `undefined`. The contract should be: a feature *cannot* call `getDependency` on a name not in its `depends`.

5. **Default configuration.** What does "out of the box" look like? `loadContainerRuntime(...)` (the legacy entry point) presumably calls `config(Features)` (everything on) by default to preserve backward compat. Confirm.

6. **Versioning of the framework itself.** When new lifecycle phases are added, existing features should be unaffected. Phase additions are additive (existing features don't subscribe to new phases). Phase *removal* is a breaking change. Treat phase set as part of `RuntimeFeatureExpectations` capabilities?

## Next steps (post-spike)

The order I'd suggest, each as its own branch:

1. **Resolve open questions from the GC spike.** Specifically: shape of node-activity observation hooks (push/pull/walk), and whether to add a `dispose` lifecycle phase. These are spec decisions, not implementation work — could be a single design doc PR that updates `runtimeFeature.ts` interfaces.
2. **Spike a third feature** (idCompressor recommended) to confirm the "membership host split" intuition. If idCompressor doesn't use `clientDetails` / `getQuorum` either, split them out. Cheap to do; expensive to undo after engine ships.
3. Implement the engine. Real `install()` plumbing, real lifecycle driver, real dependency resolver. No real features yet — just the spike stubs becoming no-op real installs. Validates the framework works.
4. Extract one small feature end-to-end. Suggest `idCompressor` (smallest blast radius, well-encapsulated). This becomes the migration template.
5. Extract GC. Self-contained-ish despite the deep coupling; the second spike confirmed the framework can express its needs once observation hooks exist.
6. Extract summarizer. Largest blast radius; do *after* GC because summarizer's `depends: ["feature:garbageCollection"]` means GC must already be a real feature for the summarizer extraction to land.
7. Build the `pendingRehydration` feature as a *new* module against the framework. This is the original question that started the design exploration: with the framework in place, the question becomes "what does this feature's `install` look like?" — a much clearer question than "what config flag should we add?"
