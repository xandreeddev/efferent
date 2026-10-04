import { Context, Effect, Layer, Option, Schema } from "effect"
import { Capabilities, defineCapability, definePlugin } from "@xandreed/core"

export const SMITH_EFFECT_MODULE_IDS = ["foundations", "schema", "services", "concurrency", "ai", "architecture"] as const
export const SmithEffectModule = Schema.Literals(SMITH_EFFECT_MODULE_IDS)
export type SmithEffectModule = typeof SmithEffectModule.Type
export const SelectedSmithModules = Context.Reference<ReadonlyArray<SmithEffectModule>>("smith/SelectedModules", { defaultValue: () => [] })
const modules: ReadonlyArray<{ readonly id: SmithEffectModule; readonly instructions: string }> = [
  { id: "foundations", instructions: `Write Effect 4 code in the repository's installed dialect. Compose typed Effects and use Effect.gen for sequential workflows. Errors are values: Schema.TaggedError and typed error channels; adapt foreign promises with Effect.tryPromise at adapter boundaries. Use const, immutable values, Array combinators, Effect.reduce and Ref; never let/var, imperative loops, throw, try/catch or Promise concurrency. Use Option for absence and Match for discriminated unions. Preserve inference instead of laundering types with any or double casts. Check the installed Effect exports before using an unfamiliar API.` },
  { id: "schema", instructions: `Use Effect Schema as the single source of runtime validation and domain types. Define entities with Schema.Class or Struct; derive types from schemas instead of parallel interfaces. Brand identifiers and model value objects with validated schemas. Decode unknown input at boundaries with Schema.decodeUnknownEffect and encode through the same contract. Use Schema.OptionFromNullOr or OptionFromOptional where wire absence must become Option; keep domain absence explicit. Validate invariants at construction and avoid plain objects that bypass entity constructors.` },
  { id: "services", instructions: `Model dependencies as Context.Service ports and implement them with Layer adapters. Keep domain and use-case functions independent of provider, host and runtime imports. Capture services inside Layer.effect so returned operations retain typed errors without leaking runtime requirements. Construct and provide layers at composition roots; never run an Effect from domain code. Use scoped acquisition/finalization for resources, and preserve failure/cancellation through adapter seams.` },
  { id: "concurrency", instructions: `Use Effect native concurrency: Effect.all/forEach with explicit bounded concurrency for independent reads, fibers scoped to their owner, and Deferred/Queue/PubSub/Ref/Semaphore when coordination is needed. Keep dependent operations sequential. Serialize workspace mutation; do not race writes to the same resource. Preserve interruption and use ensuring/acquireRelease for cleanup. Use Clock, Schedule and timeout combinators so timing is testable with TestClock. Never substitute Promise.all, unowned async callbacks or detached work for scoped Effects.` },
  { id: "ai", instructions: `Use effect/ai LanguageModel, Prompt, Tool and Toolkit from the installed Effect 4 package. The LanguageModel service is the model port; providers and credentials belong in adapters. Define tool inputs/success/failure with Schema; use the shared Failure shape and failureMode: return so the model can repair errors in the same run. Prefer capabilities, ToolRegistry and StepLoop over an application-specific agent loop. Version prompts, output schemas, tool views and model configuration; preserve request provenance, actual usage and provider failures in eval evidence. Never treat a narrated check as a verified result.` },
  { id: "architecture", instructions: `Keep domain concepts explicit: entities have branded identity, value objects validate meaning, ports express external dependencies, and use cases coordinate domain behavior. Use thing.entity.ts plus thing.entity.functions.ts, do-thing.usecase.ts plus do-thing.usecase.functions.ts; put contracts/Schema in the first and behavior in the second. Name ports .port.ts and adapters .adapter.ts. Dependencies point inward; compose adapters at main.ts or plugin edges. Keep presentation projections pure, failures typed and application policy separate from reusable mechanisms. Add only the abstractions needed by the task; preserve existing package boundaries.` },
]
export const smithEffectCapability = defineCapability({
  id: "smith.effect", version: "1.0.0",
  promptSections: modules.map((module, index) => ({
    id: `smith.effect.${module.id}`, version: "1.0.0", tier: "static" as const, order: 100 + index,
    render: () => SelectedSmithModules.pipe(Effect.map((selected) => selected.includes(module.id) ? Option.some(`## Effect module: ${module.id}\n${module.instructions}`) : Option.none())),
  })),
})
export const smithEffectPlugin = definePlugin({
  id: "@xandreed/smith/effect", version: "1.0.0", scope: "runtime", config: Schema.Struct({}), defaults: {},
  provides: [], contributes: [Capabilities], layer: () => Layer.succeed(Capabilities, [smithEffectCapability]),
})
