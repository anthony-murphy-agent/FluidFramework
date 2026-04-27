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
 * DESIGN SPIKE — summarizer as a {@link RuntimeFeature}.
 *
 * @remarks
 * This file is the vertical slice that drives out the framework. The shape of
 * `RuntimeFeatureHost` was determined by walking the existing summarizer code
 * and listing every runtime capability it touches — each became a method on
 * the host.
 *
 * **What lifts into this feature** (today inlined into `ContainerRuntime`):
 *
 * - `summary/summaryManager.ts` — top-level coordinator
 * - `summary/summarizerClientElection.ts` — client election
 * - `summary/summaryCollection.ts` — ack/nack tracking
 * - `summary/summarizerNode/` — node tree (couples to GC via `summarizerNodeWithGc`)
 * - `summary/summaryDelayLoadedModule/` — the actual summarizing
 * - `summary/{orderedClientElection,summarizerUtils,summaryHelpers,summaryFormat}.ts`
 *
 * **What stays in `ContainerRuntime`:**
 *
 * - The `summarize()` public method (thin shim that delegates if installed, throws if not).
 * - Summary tree assembly (collecting from data stores) — runtime core; feature triggers it via host.
 *
 * **Open: granularity.** The current code couples four distinct concerns:
 * 1. Election (which client summarizes)
 * 2. Heartbeat (when to summarize)
 * 3. Generation (producing the summary tree)
 * 4. Acks (handling Summarize/SummaryAck/SummaryNack ops)
 *
 * Splitting these into separate features (election → heartbeat → generation →
 * acks) with explicit `depends` would be more orthogonal but adds 4 entries to
 * the registry. Spike defers this; the framework supports either.
 */

/**
 * Options for the summarizer feature. Mirrors today's `ISummaryRuntimeOptions`
 * but typed loosely for the spike.
 *
 * @internal
 */
export interface SummarizerFeatureOptions {
	/**
	 * Override the server-provided summary configuration.
	 */
	readonly summaryConfigOverrides?: unknown;
}

const summarizerFeatureId: RuntimeFeatureId = "feature:summarizer";

// Placeholder for the real compatibility expectations a non-spike impl would supply.
const placeholderHostRequirements: ContainerExtensionExpectations["hostRequirements"] = {
	minSupportedGeneration: 0,
	requiredFeatures: [],
};

/**
 * Stub factory. Real implementation would lift `SummaryManager` construction
 * out of `ContainerRuntime.initializeBaseState` and into this feature's
 * `install` method.
 *
 * @internal
 */
export const SummarizerFeatureFactory: RuntimeFeatureFactory<SummarizerFeatureOptions> = {
	id: summarizerFeatureId,

	hostRequirements: placeholderHostRequirements,
	instanceExpectations: {
		generation: 1,
		version: "0.1.0-spike",
		capabilities: new Set<string>(),
	},
	resolvePriorInstantiation: () => {
		throw new Error("design spike: not implemented");
	},

	create(options: SummarizerFeatureOptions): RuntimeFeature {
		return {
			id: summarizerFeatureId,
			depends: [
				// Drove the discovery of `getDependency` on the host. Summarizer
				// reads GC data when contributing the summary tree, and the GC
				// summarizer-node hierarchy currently lives in `summarizerNodeWithGc.ts`.
				"feature:garbageCollection",
				// Election + ack-state are persisted in document metadata; if the
				// schema controller becomes a feature, summarizer reads the schema
				// version to decide which summary format to emit.
				"feature:documentSchema",
			],

			install(host: RuntimeFeatureHost): void {
				// === LIFECYCLE: post-snapshot ===
				// Today: `initializeBaseState` (containerRuntime.ts:2281+) constructs
				// SummaryCollection from snapshot metadata. Drove `on(phase, ...)`
				// and `getMetadataValue` on the host.
				host.on("loadFromSnapshot", () => {
					// would: hydrate SummarizerClientElection from
					// `host.getMetadataValue("electedSummarizerData")`
					throw new Error("design spike: not implemented");
				});

				// === LIFECYCLE: ready ===
				// Today: SummaryManager construction at containerRuntime.ts:2364, gated
				// by SummarizerClientElection.clientDetailsPermitElection. Drove
				// `clientDetails` on the host.
				host.on("ready", () => {
					if (!host.clientDetails.capabilities.interactive) {
						// summarizer client; skip election, just run.
					}
					// would: pass `host.getQuorum()` to construct SummarizerClientElection
					// + SummaryManager + watch quorum proposals
					throw new Error("design spike: not implemented");
				});

				// === LIFECYCLE: connect / disconnect ===
				// Today: SummaryManager listens to runtime "connected"/"disconnected"
				// to start/stop running summarizer (via runWhileConnectedCoordinator).
				// Drove the `connect` and `disconnect` lifecycle phases.
				host.on("connect", () => {
					throw new Error("design spike: not implemented");
				});
				host.on("disconnect", () => {
					throw new Error("design spike: not implemented");
				});

				// === OP ROUTING ===
				// Today: container-runtime's inbound op dispatch routes Summarize/
				// SummaryAck/SummaryNack to SummaryCollection (containerRuntime.ts
				// processes these via `processCore` -> message-type switch).
				// Drove `registerOpHandler` on the host.
				host.registerOpHandler("summarize", (_message, _local) => {
					throw new Error("design spike: not implemented");
				});
				host.registerOpHandler("summaryAck", (_message, _local) => {
					throw new Error("design spike: not implemented");
				});
				host.registerOpHandler("summaryNack", (_message, _local) => {
					throw new Error("design spike: not implemented");
				});

				// === OP SUBMIT ===
				// Today: SummaryManager submits the Summarize op via runtime.submit()
				// indirection. Drove `submitRuntimeMessage` on the host.
				// Used inside the runningSummarizer flow when generating a summary:
				//   host.submitRuntimeMessage("summarize", summaryGeneratorOutput);

				// === SUMMARY ORCHESTRATION ===
				// Note: summarizer is the *consumer* of contributions, not a contributor.
				// `registerSummaryContributor` is used by GC, idCompressor, etc., not by
				// summarizer. Listed on the host for completeness; see those features.

				// === DEPENDENCY USE ===
				// Drove `getDependency` on the host. Summarizer reads from GC during
				// summary generation (used routes / unreferenced node info):
				//   const gc = host.getDependency("feature:garbageCollection");

				// === TELEMETRY ===
				host.logger.send({ eventName: "SummarizerFeatureInstalled" });

				// Document any host method NOT used here so we know it was driven by
				// some other feature:
				//  - registerSummaryContributor: driven by GC, idCompressor, schema
			},
		};
	},
};

/**
 * Registry entry for the `Features` const. Pairs the factory with default options.
 *
 * @internal
 */
export const SummarizerFeature: RuntimeFeatureDefinition<SummarizerFeatureOptions> = {
	factory: SummarizerFeatureFactory,
	defaults: {},
};
