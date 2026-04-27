/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * DESIGN SPIKE — type-only tests for the RuntimeFeature framework.
 *
 * No runtime assertions. This file exists to make the spike's API surface
 * compile against realistic caller code. Wrapped in `typeChecksCompile`
 * which is never called — the value is that the body type-checks.
 */

import type {
	RuntimeFeature,
	RuntimeFeatureDefinition,
	RuntimeFeatureFactory,
	RuntimeFeatureHost,
	RuntimeFeatureId,
	RuntimeFeatureLifecyclePhase,
} from "@fluidframework/runtime-definitions/internal";

import {
	Features,
	type FeaturesRegistry,
	SummarizerFeature,
	SummarizerFeatureFactory,
	type SummarizerFeatureOptions,
} from "../runtimeFeatures/index.js";

declare function configFromAll<T extends object>(
	features: T,
): {
	without<K extends keyof T>(
		name: K,
	): { without<K2 extends Exclude<keyof T, K>>(name: K2): unknown };
};

declare function configEmpty(): {
	with<TOptions>(feature: RuntimeFeatureDefinition<TOptions>, options?: TOptions): unknown;
};

declare function makeHost(): RuntimeFeatureHost;

/**
 * Wrapped so eslint's `no-unused-vars` and `no-void` don't fire on the type
 * sketches. The function is never invoked; only its body needs to compile.
 */
export function _typeChecksCompile(): {
	registry: FeaturesRegistry;
	summarizerEntry: RuntimeFeatureDefinition<SummarizerFeatureOptions>;
	factory: RuntimeFeatureFactory<SummarizerFeatureOptions>;
	factoryId: RuntimeFeatureId;
	subtractive: unknown;
	additive: unknown;
	phases: RuntimeFeatureLifecyclePhase[];
	meta: string | undefined;
	interactive: boolean;
	dep: unknown;
	instance: RuntimeFeature;
	depends: readonly RuntimeFeatureId[];
	installFn: (host: RuntimeFeatureHost) => void;
} {
	// 1. Registry shape — every entry conforms to RuntimeFeatureDefinition.
	const registry: FeaturesRegistry = Features;
	const summarizerEntry: RuntimeFeatureDefinition<SummarizerFeatureOptions> =
		Features.summarizer;

	// 2. Factory shape — produces a feature with the right id.
	const factory: RuntimeFeatureFactory<SummarizerFeatureOptions> = SummarizerFeatureFactory;
	const factoryId: RuntimeFeatureId = factory.id;

	// 3. Caller compiles — subtractive workflow using a config helper.
	const subtractive = configFromAll(Features).without("summarizer");

	// 4. Caller compiles — additive workflow.
	const additive = configEmpty().with(SummarizerFeature, {
		summaryConfigOverrides: {},
	});

	// 5. Feature install signature — host methods are typed.
	const host = makeHost();
	const phases: RuntimeFeatureLifecyclePhase[] = [
		"construct",
		"loadFromSnapshot",
		"loadPendingAttachments",
		"applyStashedOps",
		"ready",
		"connect",
		"disconnect",
	];
	for (const phase of phases) {
		host.on(phase, () => {});
	}
	host.registerOpHandler("summarize", (_msg, _local) => {});
	host.submitRuntimeMessage("summarize", {});
	const meta: string | undefined = host.getMetadataValue<string>("electedSummarizerData");
	const interactive: boolean = host.clientDetails.capabilities.interactive;
	host.logger.send({ eventName: "test" });
	const dep: unknown = host.getDependency("feature:garbageCollection");

	// 6. Feature constructed via factory has the expected shape.
	const instance: RuntimeFeature = SummarizerFeatureFactory.create({});
	const depends: readonly RuntimeFeatureId[] = instance.depends;
	const installFn: (h: RuntimeFeatureHost) => void = instance.install;

	return {
		registry,
		summarizerEntry,
		factory,
		factoryId,
		subtractive,
		additive,
		phases,
		meta,
		interactive,
		dep,
		instance,
		depends,
		installFn,
	};
}
