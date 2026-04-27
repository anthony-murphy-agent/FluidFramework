/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type {
	ContainerExtensionExpectations,
	RuntimeFeature,
	RuntimeFeatureDefinition,
	RuntimeFeatureFactory,
	RuntimeFeatureHost,
	RuntimeFeatureId,
} from "@fluidframework/runtime-definitions/internal";

/**
 * DESIGN SPIKE — garbage collection as a {@link RuntimeFeature}.
 *
 * @remarks
 * Second vertical slice. Where the summarizer spike validated lifecycle phases
 * and op routing, this spike pushes on **runtime-internal observability**:
 * GC needs to know about node updates as they happen, which the summarizer did
 * not. That requirement surfaces new host capabilities documented inline.
 *
 * **What lifts into this feature** (today inlined into `ContainerRuntime`):
 *
 * - `gc/garbageCollection.ts` — main collector
 * - `gc/gcConfigs.ts`, `gcDefinitions.ts`, `gcHelpers.ts` — types/utilities
 * - `gc/gcReferenceGraphAlgorithm.ts` — reference-graph traversal
 * - `gc/gcSummaryDefinitions.ts`, `gcSummaryStateTracker.ts` — summary integration
 * - `gc/gcTelemetry.ts`, `gcUnreferencedStateTracker.ts` — observability/state
 *
 * **What stays in `ContainerRuntime`:**
 *
 * - The channel collection itself (GC observes it; runtime owns it).
 * - Public `summarize()` / `getGCData()` API surfaces (delegate to feature when installed).
 *
 * **Cross-feature edge to summarizer:**
 *
 * The summarizer spike declared `feature:garbageCollection` in its `depends`.
 * That edge is what powers `summarizerNodeWithGc` — summarizer reads from GC
 * during summary generation. With this spike landed, the dependency edge can
 * be exercised end-to-end (summarizer install runs after GC install; summarizer
 * `getDependency("feature:garbageCollection")` resolves).
 */

/**
 * Options for the GC feature. Mirrors today's `IGCRuntimeOptions` but typed
 * loosely for the spike.
 *
 * @internal
 */
export interface GarbageCollectionFeatureOptions {
	/** Enable permanent deletion phase (sweep). */
	readonly enableGCSweep?: boolean;
	/** Force full GC (bypass optimizations). */
	readonly runFullGC?: boolean;
	/** Session expiry timeout in ms. */
	readonly sessionExpiryTimeoutMs?: number;
	/** Delay between tombstone and sweep deletion. */
	readonly sweepGracePeriodMs?: number;
}

const garbageCollectionFeatureId: RuntimeFeatureId = "feature:garbageCollection";

const placeholderHostRequirements: ContainerExtensionExpectations["hostRequirements"] = {
	minSupportedGeneration: 0,
	requiredFeatures: [],
};

/**
 * Stub factory. Real implementation would lift the `GarbageCollector.create()`
 * call out of `ContainerRuntime`'s constructor (containerRuntime.ts:1918) into
 * this feature's `install` method.
 *
 * @internal
 */
export const GarbageCollectionFeatureFactory: RuntimeFeatureFactory<GarbageCollectionFeatureOptions> =
	{
		id: garbageCollectionFeatureId,

		hostRequirements: placeholderHostRequirements,
		instanceExpectations: {
			generation: 1,
			version: "0.1.0-spike",
			capabilities: new Set<string>(),
		},
		resolvePriorInstantiation: () => {
			throw new Error("design spike: not implemented");
		},

		create(options: GarbageCollectionFeatureOptions): RuntimeFeature {
			return {
				id: garbageCollectionFeatureId,
				// GC has no `depends` of its own — it sits at the bottom of the
				// dependency stack and is depended ON (by summarizer, future features).
				depends: [],

				install(host: RuntimeFeatureHost): void {
					// === LIFECYCLE: loadFromSnapshot ===
					// Today: containerRuntime.ts:2152 reads serialized GC configs from the
					// snapshot blob ("gcConfigs"); line 2259 calls `initializeBaseState()`
					// to hydrate the reference graph and deletion records.
					// Validates `getMetadataValue` from the summarizer spike for a
					// non-summarizer feature.
					host.on("loadFromSnapshot", () => {
						// would: const cfg = host.getMetadataValue("gcConfigs");
						//        await garbageCollector.initializeBaseState();
						throw new Error("design spike: not implemented");
					});

					// === LIFECYCLE: connect / disconnect ===
					// Today: containerRuntime.ts:3018 — `setConnectionState(canSendOps, clientId)`
					// drives sweep timing (only summarizer client runs sweep).
					host.on("connect", () => {
						throw new Error("design spike: not implemented");
					});
					host.on("disconnect", () => {
						throw new Error("design spike: not implemented");
					});

					// === LIFECYCLE: dispose ===
					// Today: containerRuntime.ts:2417 calls `garbageCollector.dispose()`
					// during runtime shutdown (cancels pending sweep timers, flushes
					// telemetry, releases references).
					//
					// **NEW HOOK SURFACED:** the framework's lifecycle phase set did not
					// include `dispose`. The summarizer spike didn't need it — summarizer
					// state is reconstructible from snapshot, no resources to release.
					// GC has timers and event subscriptions that must be torn down.
					//
					// Action item for the framework spec: add `dispose` to
					// `RuntimeFeatureLifecyclePhase` enum and document its semantics
					// (fires on runtime shutdown; features should release resources;
					// fires after `disconnect`).
					//
					// Spike continues to use the existing phase set; the dispose
					// requirement is recorded for the spec, not the stub.

					// === OP HANDLING ===
					// Today: containerRuntime.ts:3418 routes GC ops (sweep / tombstone /
					// aborted-sweep) to `garbageCollector.processMessages(...)`.
					// Validates `registerOpHandler` for non-summarizer features.
					host.registerOpHandler("gc", (_message, _local) => {
						throw new Error("design spike: not implemented");
					});

					// === OP SUBMIT ===
					// Today: GC submits sweep / tombstone ops via runtime indirection.
					// Usage shape:
					//   host.submitRuntimeMessage("gc", { type: "tombstone", ids: [...] });

					// === SUMMARY CONTRIBUTION ===
					// Today: containerRuntime.ts:2665 spreads `garbageCollector.getMetadata()`
					// into runtime metadata; line 2725 calls `garbageCollector.summarize(...)`
					// to produce the GC subtree.
					// **First exerciser** of `registerSummaryContributor`. Summarizer
					// is the orchestrator (consumer); GC is a contributor.
					host.registerSummaryContributor("gc", async () => {
						throw new Error("design spike: not implemented");
					});

					// === NODE ACTIVITY OBSERVATION ===
					// Today: containerRuntime.ts:1994, 2020, 3826 — channel collection
					// invokes `garbageCollector.nodeUpdated({...})` when a node is mutated,
					// when blobs are uploaded, when handles are bound. Line 1998:
					// `isNodeDeleted` callback so the channel collection can refuse to
					// surface deleted nodes.
					//
					// **NEW HOOK SURFACED:** the runtime fires events on data-store /
					// channel activity that GC must observe to maintain its reference
					// graph. The summarizer spike did not need this — summarizer is a
					// snapshot-and-respond consumer, not a continuous observer of state
					// changes.
					//
					// Three sub-shapes the framework needs to settle:
					//
					// 1. `host.onNodeUpdated(handler)` — receive { nodeId, type, ... }
					//    when channel/data-store state is mutated. Push.
					// 2. `host.registerNodeFilter("isDeleted", predicate)` — runtime asks
					//    the feature whether a node should be visible. Pull. (Today's
					//    `isNodeDeleted` callback is exactly this shape.)
					// 3. `host.walkChannelGraph(visitor)` — feature traverses the live
					//    reference graph. Today implemented via dedicated runtime methods
					//    `getGCData` etc.; could be a host capability.
					//
					// Action item for the framework spec: decide between a generic
					// `host.events` listenable (similar to ExtensionHost.events) versus
					// targeted methods. GC needs all three; weighing surface area vs
					// type-safety of the targeted form is open.
					//
					// Spike encodes this need as comments here, not a stub call, since
					// the host interface doesn't yet have these methods. That's the
					// finding — surfacing the gap is the value.

					// === DEPENDENCY VALIDATION ===
					// GC has empty `depends`. It does not call `host.getDependency(...)`.
					// Validates that features at the bottom of the dependency stack
					// compile and install cleanly with no upstream consumers reachable
					// at install time.

					// === TELEMETRY ===
					host.logger.send({ eventName: "GarbageCollectionFeatureInstalled" });
				},
			};
		},
	};

/**
 * Registry entry. Pairs the factory with default options.
 *
 * @internal
 */
export const GarbageCollectionFeature: RuntimeFeatureDefinition<GarbageCollectionFeatureOptions> =
	{
		factory: GarbageCollectionFeatureFactory,
		defaults: {},
	};
