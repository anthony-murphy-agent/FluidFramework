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
 * DESIGN SPIKE — staging mode as a {@link RuntimeFeature}.
 *
 * @remarks
 * Third vertical slice. Where summarizer pushed on lifecycle/op routing and GC
 * pushed on runtime-internal observability, this spike pushes on the
 * **user-facing-API** axis. Staging mode is the most user-facing capability in
 * the runtime — apps explicitly call `runtime.enterStagingMode()`, hold the
 * returned `StageControls`, listen to `stagingModeChanged` events, and decide
 * when to commit or discard.
 *
 * That public-surface character drives the two new host shapes the spike
 * surfaces:
 *
 * - **Public API contribution.** Features that consumers call directly need a way to attach methods/properties to the runtime they hand back. Summarizer/GC didn't need this — they're invisible to consumers.
 * - **Op-submit middleware.** Staging mode tags every outgoing op with a `staged` flag while active. This is op-pipeline middleware — neither summarizer nor GC needed to transform ops authored by other features.
 *
 * **What lifts into this feature** (today inlined into `ContainerRuntime`):
 *
 * - `enterStagingMode` / `inStagingMode` / `enterStagingModeCore` / `exitStagingMode` plumbing (containerRuntime.ts:3666-3790)
 * - `stagingModeChanged` event emission (containerRuntime.ts:3749, 3785)
 * - `staged` flag tagging on outgoing batches (containerRuntime.ts:4819)
 * - `stagingModeAutoFlushThreshold` enforcement (containerRuntime.ts:4888)
 * - StageControls / StageControlsInternal types (currently in runtime-definitions)
 *
 * **What stays in `ContainerRuntime`:**
 *
 * - PendingStateManager (which staged batches plug into).
 * - The op submit pipeline itself; staging mode tags via middleware.
 * - The batch runner; staging mode wraps it but doesn't replace it.
 *
 * **Connection to the original conversation thread:**
 *
 * The `pendingRehydration` feature (the original question that started this
 * design exploration) declares `depends: ["feature:stagingMode"]`. With this
 * spike landed, that dependency edge has a real target: pending-state
 * rehydration's install hook would call into staging mode's API to enter
 * staging mode at the right moment in the load lifecycle (before
 * `applyStashedOps`).
 */

/**
 * Options for staging mode. Mirrors today's `stagingModeAutoFlushThreshold`
 * runtime option but typed at the feature level.
 *
 * @internal
 */
export interface StagingModeFeatureOptions {
	/**
	 * Auto-flush threshold (ops) — staged batch is flushed when this many
	 * staged ops accumulate. Defaults to today's runtime constant.
	 */
	readonly autoFlushThreshold?: number;
}

const stagingModeFeatureId: RuntimeFeatureId = "feature:stagingMode";

const placeholderHostRequirements: ContainerExtensionExpectations["hostRequirements"] = {
	minSupportedGeneration: 0,
	requiredFeatures: [],
};

/**
 * Stub factory. Real implementation would lift the staging-mode plumbing from
 * `ContainerRuntime` into this module.
 *
 * @internal
 */
export const StagingModeFeatureFactory: RuntimeFeatureFactory<StagingModeFeatureOptions> = {
	id: stagingModeFeatureId,

	hostRequirements: placeholderHostRequirements,
	instanceExpectations: {
		generation: 1,
		version: "0.1.0-spike",
		capabilities: new Set<string>(),
	},
	resolvePriorInstantiation: () => {
		throw new Error("design spike: not implemented");
	},

	create(options: StagingModeFeatureOptions): RuntimeFeature {
		return {
			id: stagingModeFeatureId,
			// Staging mode is a leaf in the dependency graph today. It does not
			// reach into other features. Other features (pendingRehydration) depend
			// on IT.
			depends: [],

			install(host: RuntimeFeatureHost): void {
				// === LIFECYCLE: ready ===
				// Today: staging mode is initialized lazily in the constructor (no
				// snapshot read needed — it's a session-local concept). The feature
				// just needs to be wired and ready to receive enterStagingMode calls.
				host.on("ready", () => {
					throw new Error("design spike: not implemented");
				});

				// === PUBLIC API CONTRIBUTION ===
				//
				// **NEW HOOK SURFACED:** features that contribute to the runtime's
				// public surface need a way to register methods/properties/events.
				// The summarizer and GC spikes did not need this — they are invisible
				// to consumers.
				//
				// Three sub-shapes the framework needs to settle:
				//
				// (a) Method contribution:
				//
				//     host.exposeRuntimeMethod("enterStagingMode", () => {
				//       // implementation that returns StageControls
				//     });
				//
				//     Consumers then call `runtime.enterStagingMode()` and get the
				//     contributed implementation.
				//
				// (b) Property contribution:
				//
				//     host.exposeRuntimeProperty("inStagingMode", () => /* getter */);
				//
				// (c) Event contribution:
				//
				//     const emitter = host.exposeRuntimeEvent<StagingModeChangedEvent>(
				//       "stagingModeChanged",
				//     );
				//     // later: emitter.emit({ inStagingMode: true });
				//
				// Open: type-level enforcement. If `runtime.enterStagingMode` is only
				// available when the staging-mode feature is installed, the runtime's
				// type must reflect that. Two options:
				//
				//   - **Phantom config types.** `Config<{ stagingMode: true }>` →
				//     `Runtime & WithStagingMode`. Type-safe; complex.
				//   - **Always present, throws when absent.** `runtime.enterStagingMode`
				//     exists on the type, throws "feature not installed" at call time.
				//     Simpler; loses compile-time check.
				//
				// Spike defers the choice; both shapes can be expressed against the
				// same `host.exposeRuntimeMethod` primitive.

				// === OP-SUBMIT MIDDLEWARE ===
				//
				// **NEW HOOK SURFACED:** while staging mode is active, every outgoing
				// op gets a `staged: true` flag (containerRuntime.ts:4819). That's
				// op-pipeline middleware — the feature transforms ops authored by
				// OTHER features (DDS ops from data stores, summarize ops from
				// summarizer, etc.) before they reach the wire.
				//
				// Shape:
				//
				//     host.registerOpSubmitMiddleware((op) => {
				//       if (this.inStagingMode) {
				//         return { ...op, metadata: { ...op.metadata, staged: true } };
				//       }
				//       return op;
				//     });
				//
				// Open questions for the spec:
				//
				// - Ordering: middleware runs in feature topological order? Or its
				//   own explicit order ("after compression", "before persistence")?
				//   Today's pipeline is hardcoded.
				// - Mutation vs return-new: today's code mutates the batch. The
				//   middleware contract should be functional (return-new) for safety.
				// - Failures: what does a middleware that throws do to the op? Today,
				//   throwing in the runtime crashes the container; middleware needs
				//   the same contract or explicit recovery semantics.

				// === LOCAL OP QUEUE INTERACTION ===
				//
				// **NEW HOOK SURFACED:** committing or discarding staged changes
				// requires invoking PendingStateManager-level operations:
				//
				// - `commitChanges()` → `pendingStateManager.replayPendingStates(...)`
				//   filtered to staged batches, marking them as committed.
				// - `discardChanges()` → pop staged batches, run rollback callbacks.
				//
				// Today (containerRuntime.ts:3756-3782) staging mode reaches directly
				// into private fields of the runtime to drive this. As a feature,
				// staging mode needs host-mediated access:
				//
				//     host.localOpQueue.replay(filter);
				//     host.localOpQueue.discard(filter);
				//
				// Open: whether `host.localOpQueue` is a primitive on every host, or
				// whether `pendingStateManager` itself becomes a feature that
				// stagingMode depends on (and acquires via `getDependency`).
				//
				// Spike leans toward the latter — PSM is heavyweight enough to be its
				// own feature, and the dependency edge would be explicit. But the
				// pendingRehydration feature would also depend on it, so PSM-as-feature
				// is at least a 2-tenant abstraction. Worth doing.

				// === EVENT EMISSION ===
				// Emits `stagingModeChanged` (today: containerRuntime.ts:3749, 3785).
				// Uses the public-event-contribution shape above.

				// === HOOKS NOT USED ===
				//
				// Confirms the membership-host split hypothesis from the GC spike:
				//
				// - `clientDetails` — NOT used. Staging mode is session-local; doesn't
				//   care about interactive vs summarizer client.
				// - `getQuorum` — NOT used. No cross-client coordination; staging
				//   mode lives entirely in this client's local state.
				// - `getMetadataValue` — NOT used. Staging mode is not persisted in
				//   the snapshot; it's recreated fresh on load.
				// - `registerSummaryContributor` — NOT used. Contributes nothing to
				//   the summary tree.
				// - `registerOpHandler` — NOT used. Has no own op type; tags others'.
				// - `submitRuntimeMessage` — NOT used. Tagging happens via middleware
				//   on others' ops, not via direct submission.
				//
				// 3-of-3 spikes have not used `getQuorum`. 2-of-3 (GC + stagingMode)
				// have not used `clientDetails`. The case for splitting election-shaped
				// hooks into a `RuntimeMembershipHost` sub-interface that summarizer
				// alone acquires is now strong. See "Next steps" in the design doc.

				// === TELEMETRY ===
				host.logger.send({ eventName: "StagingModeFeatureInstalled" });
			},
		};
	},
};

/**
 * Registry entry. Pairs the factory with default options.
 *
 * @internal
 */
export const StagingModeFeature: RuntimeFeatureDefinition<StagingModeFeatureOptions> = {
	factory: StagingModeFeatureFactory,
	defaults: {},
};
