/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { GarbageCollectionFeature } from "./garbageCollection.js";
import { SummarizerFeature } from "./summarizer.js";

export {
	GarbageCollectionFeature,
	GarbageCollectionFeatureFactory,
	type GarbageCollectionFeatureOptions,
} from "./garbageCollection.js";
export {
	SummarizerFeature,
	SummarizerFeatureFactory,
	type SummarizerFeatureOptions,
} from "./summarizer.js";

/**
 * DESIGN SPIKE — registry of all available runtime features.
 *
 * @remarks
 * This is the spine of the framework. Reading this object tells you the entire
 * capability surface of `ContainerRuntime`. Consumers select features by
 * referencing entries here:
 *
 * ```ts
 * // Subtractive: start with everything, remove what you don't want.
 * const cfg = config(Features).without("summarizer");
 *
 * // Additive: start empty, add what you need.
 * const cfg = config({}).with(Features.summarizer);
 * ```
 *
 * The spike ships only the summarizer entry. Each TODO below is a follow-up
 * extraction; landing one means lifting that subsystem out of `ContainerRuntime`
 * into its own feature module under this folder.
 *
 * @internal
 */
export const Features = {
	summarizer: SummarizerFeature,
	garbageCollection: GarbageCollectionFeature,

	// === TODO: extract these into RuntimeFeature modules ===
	// Each currently lives inlined in ContainerRuntime; landing one means:
	// 1. Lift the subsystem code into ./<name>.ts
	// 2. Add the entry here
	// 3. Update `ContainerRuntime` to delegate to the feature when installed
	//
	// idCompressor      — runtime constructor lines that build IIdCompressor
	// compression       — packages/runtime/container-runtime/src/opLifecycle/
	// stagingMode       — runtime methods enterStagingMode/exitStagingMode + StagingControls plumbing
	// schemaUpgrade     — packages/runtime/container-runtime/src/documentSchema.ts
	// pendingRehydration — depends on stagingMode; the hooks pending-state load needs (the
	//                      original question that started this design exploration)
} as const;

/**
 * Type of the {@link Features} registry. Consumers can use this as a constraint
 * on configuration objects.
 *
 * @internal
 */
export type FeaturesRegistry = typeof Features;
