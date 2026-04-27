/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { ContainerExtensionExpectations } from "./containerExtensionProvider.js";

/**
 * DESIGN SPIKE — interfaces only, no implementation.
 *
 * @remarks
 * Sibling to `ContainerExtension` (in `container-runtime-definitions`). The two systems
 * coexist:
 *
 * - `ContainerExtension` — pull-based, signal/connection plugins (e.g. Presence)
 * - `RuntimeFeature` — push-based, lifecycle-integrated subsystems (summarizer, GC, etc.)
 *
 * The runtime hosts both. Naming is intentionally distinct so call sites are
 * unambiguous. The shape of the framework is derived from the requirements
 * surfaced by the summarizer vertical-slice spike — every method on
 * {@link RuntimeFeatureHost} traces to a concrete need from at least one feature.
 *
 * See `packages/runtime/container-runtime/docs/runtime-feature.md` for the
 * design narrative, including the gap analysis vs ContainerExtension and the
 * findings that drove this surface.
 */

/**
 * Named lifecycle phases the engine drives. Features register hooks against
 * these phases; within a phase, features run in dependency-topological order.
 *
 * @remarks
 * The phase set was chosen by walking `ContainerRuntime.loadRuntime2` and
 * naming each meaningful boundary. It is expected to grow; add a new phase
 * when a feature needs a hook that doesn't fit any existing one.
 *
 * Ordering during load: `construct`, then `loadFromSnapshot`, then
 * `loadPendingAttachments`, then `applyStashedOps`, then `ready`.
 *
 * Connection lifecycle (post-load, possibly many times): `connect`, then `disconnect`.
 *
 * @internal
 */
export type RuntimeFeatureLifecyclePhase =
	| "construct"
	| "loadFromSnapshot"
	| "loadPendingAttachments"
	| "applyStashedOps"
	| "ready"
	| "connect"
	| "disconnect";

/**
 * Unique identifier for a runtime feature.
 *
 * @remarks
 * Mirrors {@link @fluidframework/runtime-definitions#ContainerExtensionId}'s
 * `<scheme>:<id>` convention. Reuse of the same scheme namespace is fine —
 * features and extensions are disjoint sets.
 *
 * @internal
 */
export type RuntimeFeatureId = `${string}:${string}`;

/**
 * Runtime surface exposed to a {@link RuntimeFeature} during install.
 *
 * @remarks
 * This is the primary design artifact of the spike. Each method exists because
 * a feature needs it; the design doc records which feature drove which method.
 *
 * @internal
 */
export interface RuntimeFeatureHost {
	/**
	 * Register a callback for a lifecycle phase. May be called multiple times
	 * for the same phase; callbacks fire in feature dependency order.
	 *
	 * @remarks
	 * Driven by: every feature. The fundamental hook of the framework.
	 */
	on(phase: RuntimeFeatureLifecyclePhase, callback: () => void | Promise<void>): void;

	/**
	 * Register a handler for a runtime op type. The engine routes inbound ops
	 * matching `messageType` to the handler.
	 *
	 * @remarks
	 * Driven by: summarizer (needs to observe SummaryAck/SummaryNack ops). Will
	 * also be needed by future features that own their own op types.
	 */
	registerOpHandler(
		messageType: string,
		handler: (message: unknown, local: boolean) => void,
	): void;

	/**
	 * Submit a runtime op originating from this feature.
	 *
	 * @remarks
	 * Driven by: summarizer (submits Summarize ops). Symmetric with
	 * {@link RuntimeFeatureHost.registerOpHandler}.
	 */
	submitRuntimeMessage(messageType: string, content: unknown): void;

	/**
	 * Register a contribution to the container summary tree.
	 *
	 * @remarks
	 * Driven by: not the summarizer feature itself (it's the consumer / orchestrator
	 * of contributions), but features the summarizer collects from — e.g. GC,
	 * ID compressor, document schema. Listed here for spec completeness; the
	 * summarizer feature uses a sibling method to drive the orchestration.
	 */
	registerSummaryContributor(
		key: string,
		contributor: () => Promise<unknown> /* TODO: tighten to ISummaryTreeWithStats once lifted */,
	): void;

	/**
	 * Read a value from the snapshot metadata blob, if present.
	 *
	 * @remarks
	 * Driven by: summarizer (reads `electedSummarizerData` and summary stats from
	 * snapshot metadata to reconstitute election + ack state).
	 */
	getMetadataValue<T = unknown>(key: string): T | undefined;

	/**
	 * Client details for the current session (interactive vs summarizer client,
	 * capabilities, etc.).
	 *
	 * @remarks
	 * Driven by: summarizer (election eligibility check —
	 * `SummarizerClientElection.clientDetailsPermitElection`).
	 */
	readonly clientDetails: { readonly capabilities: { readonly interactive: boolean } };

	/**
	 * Quorum view; needed for client-election features.
	 *
	 * @remarks
	 * Driven by: summarizer (elects the summarizer client via quorum proposals).
	 */
	getQuorum(): unknown /* TODO: IQuorumClients once lifted; avoiding driver-definitions dependency for the spike */;

	/**
	 * Telemetry sink scoped to this feature.
	 *
	 * @remarks
	 * Driven by: every feature.
	 */
	readonly logger: { send: (event: { eventName: string; [k: string]: unknown }) => void };

	/**
	 * Get a handle to a feature this one declared a dependency on.
	 *
	 * @remarks
	 * Driven by: summarizer (depends on `garbageCollection` for GC summary
	 * contribution and on `documentSchema` for schema metadata).
	 *
	 * Throws at install time if `name` is not in this feature's
	 * {@link RuntimeFeature.depends} array — declaring dependencies is the
	 * mechanism by which the engine enforces order.
	 */
	getDependency<T = unknown>(name: string): T;
}

/**
 * A pluggable runtime feature.
 *
 * @remarks
 * Features are declared via {@link RuntimeFeatureFactory} and registered in
 * a config object passed at runtime construction. The engine instantiates
 * each feature exactly once, calls `install`, and then drives the lifecycle.
 *
 * @internal
 */
export interface RuntimeFeature {
	/**
	 * Stable identifier; matches the key used in the config object.
	 */
	readonly id: RuntimeFeatureId;

	/**
	 * Other features this one needs. Resolved topologically by the engine; if
	 * any are missing from the config, the engine refuses to start.
	 *
	 * @remarks
	 * Empty array = no dependencies (independent feature).
	 */
	readonly depends: readonly RuntimeFeatureId[];

	/**
	 * Hook registration. Called once during runtime construction, before any
	 * lifecycle phase fires.
	 */
	install(host: RuntimeFeatureHost): void;
}

/**
 * Factory shape for instantiating a {@link RuntimeFeature}.
 *
 * @remarks
 * Mirrors {@link @fluidframework/container-runtime-definitions#ContainerExtensionFactory}
 * for repo consistency, but produces a `RuntimeFeature` (lifecycle-integrated)
 * rather than a `ContainerExtension` (signal-driven).
 *
 * @internal
 */
export interface RuntimeFeatureFactory<TOptions = void>
	extends ContainerExtensionExpectations {
	readonly id: RuntimeFeatureId;
	create(options: TOptions): RuntimeFeature;
}

/**
 * Convenience: a feature definition + default options. Used as the value type
 * in the const `Features` registry consumers iterate over.
 *
 * @internal
 */
export interface RuntimeFeatureDefinition<TOptions = void> {
	readonly factory: RuntimeFeatureFactory<TOptions>;
	readonly defaults: TOptions;
}
