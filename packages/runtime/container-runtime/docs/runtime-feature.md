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

Three vertical slices have been sketched, each chosen to push on a different axis of the framework:

| Spike | Axis pushed | Verdict |
|---|---|---|
| **summarizer** | Lifecycle phases + op routing | Confirmed core surface |
| **garbage collection** | Runtime-internal observability | Surfaced `dispose` + node-activity hooks |
| **staging mode** | User-facing public API + op-submit middleware | Surfaced two new hook categories |

Each spike was conducted by walking the existing implementation and listing every runtime capability it touches.

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

### Findings from the staging-mode spike

Pushed on a third axis: **user-facing public API**. Where summarizer and GC are invisible to consumers, staging mode is one of the most directly-used capabilities of the runtime — apps explicitly call `runtime.enterStagingMode()`, hold the returned `StageControls`, listen to `stagingModeChanged`, and decide when to commit/discard.

#### Validations

- **Membership-host split hypothesis confirmed at N=3.** Staging mode does not use `clientDetails`, does not use `getQuorum`. Only summarizer (1 of 3 spikes) uses these. Splitting them into a `RuntimeMembershipHost` sub-interface that summarizer-shaped features acquire on demand is now the recommended path.
- **Snapshot independence.** Staging mode does not use `getMetadataValue` — it's purely session-local state, recreated fresh on load. Some features need persistence; some don't. The framework correctly makes `getMetadataValue` optional rather than required.
- **No-summary-no-ops contributors are real.** Staging mode contributes nothing to the summary tree, has no own op type, doesn't observe runtime activity. A feature can install with empty `depends` and use only lifecycle phases + the new public-API hooks. Validates that the framework doesn't impose unused hooks on lean features.

#### Hooks staging mode *surfaced*

Two new categories, both significant:

**1. Public-API contribution.** Features that consumers call directly need a way to attach methods/properties/events to the runtime they hand back to the app. Three sub-shapes:

- `host.exposeRuntimeMethod(name, impl)` — method contribution (`enterStagingMode`)
- `host.exposeRuntimeProperty(name, getter)` — property contribution (`inStagingMode`)
- `host.exposeRuntimeEvent<T>(name)` → `Emitter<T>` — event contribution (`stagingModeChanged`)

This raises a deeper design question: **type-level discoverability.** Should `runtime.enterStagingMode` only exist on the runtime's type when the staging-mode feature is installed?

- **Phantom config types**: `Config<{ stagingMode: true }>` resolves to `Runtime & WithStagingMode`. Type-safe, complex, intrusive on consumers.
- **Always-typed, runtime-throws**: methods always exist on the type; throw "feature not installed" if called when feature is absent. Simpler, loses compile-time check.

The spike defers but documents both as expressible against the same `host.exposeRuntimeMethod` primitive. The choice is a separate design decision from the framework shape itself.

**2. Op-submit middleware.** Staging mode tags every outgoing op with a `staged: true` flag while active. This is op-pipeline middleware — the feature transforms ops authored by *other* features (DDS ops from data stores, Summarize ops from summarizer, etc.) before they reach the wire.

```ts
host.registerOpSubmitMiddleware((op) => {
    if (this.inStagingMode) {
        return { ...op, metadata: { ...op.metadata, staged: true } };
    }
    return op;
});
```

Open questions for the spec:

- **Ordering.** Does middleware run in feature topological order? Or its own explicit pipeline ("after compression, before persistence")? Today's pipeline is hardcoded; making it composable is the unlock but also the complexity.
- **Mutation semantics.** Functional (return-new) for safety, or in-place (faster) for the hot path? Today's code mutates.
- **Error handling.** A middleware that throws — does the op get dropped, retried, or does the container close? Spec needs to pin this down.

#### Hooks staging mode would need but the framework doesn't yet have cleanly

`commitChanges` / `discardChanges` from `StageControls` reach into `PendingStateManager` to replay or discard staged batches. As a feature, staging mode needs host-mediated access:

```ts
host.localOpQueue.replay(filter);   // for commit
host.localOpQueue.discard(filter);  // for discard
```

The cleaner alternative: **PendingStateManager itself becomes a feature** (`feature:pendingStateManager`) that staging mode lists in `depends`. PSM is heavyweight enough to warrant its own module; it would also be depended on by the future `pendingRehydration` feature. Two-tenant abstraction is meaningful.

The spike leans toward PSM-as-feature. Adding it to the registry is left to the next round.

#### How this connects to the original conversation thread

The whole design exploration started with the question of how to expose pending-state rehydration with staging mode. That feature now has a clean shape against the framework:

```ts
{
  id: "feature:pendingRehydration",
  depends: ["feature:stagingMode", "feature:pendingStateManager"],
  install(host) {
    host.on("loadFromSnapshot", () => {
      const stagingMode = host.getDependency("feature:stagingMode");
      // Caller config decides whether to enter; feature observes and acts.
      // The original "should we enter staging mode?" config flag becomes
      // a question the consumer answers via property observation, not a
      // framework setting. (User's design instinct from earlier in the
      // session, validated by working all the way down.)
    });
  },
}
```

The original ad-hoc PR direction (`enableStagingModeOnPendingState: true` flag on `loadContainerRuntimeAlpha`) is fully replaced by composing two features the consumer opts into.

## Open questions

1. **Phantom typing of config.** Should `Config<{ summarizer: true }>` produce `Runtime & WithSummarizer` so callers know typed-statically what they have? Phase 2; spike uses runtime checks (feature absent → method throws / returns `undefined`).

2. **Sync vs async install.** `install()` in this spike is synchronous. Some features may need IO (e.g. summarizer reading metadata). Should `install` be `async`, or should features defer IO to `loadFromSnapshot` phase callbacks? Lean toward the latter (sync install, IO in lifecycle hooks) because it preserves a clean "all features installed before any IO" invariant.

3. **`RuntimeFeatureHost` vs `ExtensionHost` — common ancestor?** Both expose telemetry, logger, quorum, audience. Could share a base `RuntimeMemberHost` that both extend. Not done in spike to avoid premature unification; let the second feature confirm the overlap is real.

4. **Removing built-ins.** When a feature is excluded, its absence must be observable to other features that might reach for it. `getDependency("feature:summarizer")` should throw cleanly, not return `undefined`. The contract should be: a feature *cannot* call `getDependency` on a name not in its `depends`.

5. **Default configuration.** What does "out of the box" look like? `loadContainerRuntime(...)` (the legacy entry point) presumably calls `config(Features)` (everything on) by default to preserve backward compat. Confirm.

6. **Versioning of the framework itself.** When new lifecycle phases are added, existing features should be unaffected. Phase additions are additive (existing features don't subscribe to new phases). Phase *removal* is a breaking change. Treat phase set as part of `RuntimeFeatureExpectations` capabilities?

## Next steps (post-spike)

After three spikes, the spec questions are concrete enough to act on. Order by branch:

1. **Resolve spec questions surfaced by the spikes.** A single design-doc PR updating `runtimeFeature.ts`:
    - Add `dispose` to `RuntimeFeatureLifecyclePhase` (GC).
    - Decide node-activity observation shape: `host.events` listenable vs targeted methods vs sub-interface (GC).
    - Split `RuntimeMembershipHost` (`clientDetails`, `getQuorum`) as an opt-in sub-interface — confirmed by 3 spikes, only summarizer uses them.
    - Add public-API contribution methods: `exposeRuntimeMethod`, `exposeRuntimeProperty`, `exposeRuntimeEvent` (staging mode).
    - Add op-submit middleware: `registerOpSubmitMiddleware`, with ordering/mutation/error semantics pinned down (staging mode).
    - Decide on phantom-typed config vs always-typed runtime (staging mode).

2. **Implement the engine.** Real `install()` plumbing, real lifecycle driver with the now-final phase list, real dependency resolver. No real features — just the spike stubs becoming no-op real installs. Validates the framework works.

3. **Extract one small feature end-to-end.** `idCompressor` is the recommended migration template — small blast radius, well-encapsulated, would also serve as a 4th-spike sanity check on the membership-host split if needed.

4. **Extract `pendingStateManager` as a feature.** Staging mode and pending-rehydration both depend on it. Lifting PSM into a feature module is the load-bearing prerequisite for both.

5. **Extract staging mode.** Self-contained once PSM is a feature. User-facing API contributions get exercised end-to-end.

6. **Extract GC.** Self-contained-ish despite the deep coupling; the GC spike confirmed the framework can express its needs once observation hooks exist.

7. **Extract summarizer.** Largest blast radius; do *after* GC because summarizer's `depends: ["feature:garbageCollection"]` means GC must already be a real feature for the summarizer extraction to land.

8. **Build the `pendingRehydration` feature as a *new* module against the framework.** This is the original question that started the design exploration. With the framework in place plus stagingMode and pendingStateManager extracted, the feature is straightforward: it depends on both, observes pending-state-loaded, and decides via consumer config whether to enter staging mode. The original ad-hoc `enableStagingModeOnPendingState: true` flag is fully replaced by feature composition.
