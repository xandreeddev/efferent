import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import { DefaultSettings, SettingsStore } from "@xandreed/sdk-core"
import type { Settings } from "@xandreed/sdk-core"
import { SMITH_LIMIT_DEFAULTS, SMITH_MODEL_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import { applySmithSettings, smithSettingsStore } from "./smithSettings.js"

const baseRun: SmithRunConfig = {
  task: "do the thing",
  cwd: "/tmp/ws",
  acceptance: [],
  maxAttempts: SMITH_LIMIT_DEFAULTS.maxAttempts,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  models: { general: Option.none(), code: Option.none(), fast: Option.none() },
  allowBash: false,
  headless: true,
  testCommand: Option.none(),
  noTest: false,
  configPath: Option.none(),
}

describe("applySmithSettings — precedence", () => {
  test("virgin settings get the full smith defaults", () => {
    const out = applySmithSettings(DefaultSettings, baseRun)
    expect(out.model).toBe(SMITH_MODEL_DEFAULTS.general)
    expect(out.codeModel).toBe(SMITH_MODEL_DEFAULTS.code)
    expect(out.fastModel).toBe(SMITH_MODEL_DEFAULTS.fast)
    expect(out.openCodeThinkingMode).toBe("high")
    expect(out.autoLoop).toBe(false)
    expect(out.agentMode).toBe("direct")
    expect(out.maxSteps).toBe(40)
    expect(out.subAgentMaxChildren).toBe(4)
    expect(out.subAgentMaxDepth).toBe(1)
    expect(out.allowBash).toBe(false)
  })

  test("user config wins over smith defaults", () => {
    const configured: Settings = {
      ...DefaultSettings,
      model: "google:gemini-3.5-pro",
      codeModel: "opencode:glm-5.1",
      openCodeThinkingMode: "off",
      autoLoop: true,
      agentMode: "swarm",
      maxSteps: 60,
      subAgentMaxChildren: 9,
    }
    const out = applySmithSettings(configured, baseRun)
    expect(out.model).toBe("google:gemini-3.5-pro")
    expect(out.codeModel).toBe("opencode:glm-5.1")
    // fastModel untouched by the user → smith default still applies.
    expect(out.fastModel).toBe(SMITH_MODEL_DEFAULTS.fast)
    expect(out.openCodeThinkingMode).toBe("off")
    expect(out.autoLoop).toBe(true)
    expect(out.agentMode).toBe("swarm")
    expect(out.maxSteps).toBe(60)
    expect(out.subAgentMaxChildren).toBe(9)
  })

  test("CLI flags win over user config", () => {
    const configured: Settings = { ...DefaultSettings, model: "google:gemini-3.5-pro" }
    const run: SmithRunConfig = {
      ...baseRun,
      models: {
        general: Option.some("anthropic:claude-sonnet-5"),
        code: Option.some("opencode:kimi-k2.5"),
        fast: Option.none(),
      },
      allowBash: true,
    }
    const out = applySmithSettings(configured, run)
    expect(out.model).toBe("anthropic:claude-sonnet-5")
    expect(out.codeModel).toBe("opencode:kimi-k2.5")
    expect(out.fastModel).toBe(SMITH_MODEL_DEFAULTS.fast)
    expect(out.allowBash).toBe(true)
  })
})

describe("smithSettingsStore — the wrapping layer", () => {
  /** A fake inner store over a Ref, recording what `update`'s diff would see. */
  const fakeInner = (initial: Settings) =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial)
      const layer = Layer.succeed(
        SettingsStore,
        SettingsStore.of({
          get: () => Ref.get(ref),
          global: () => Ref.get(ref),
          update: (f) => Ref.updateAndGet(ref, f),
          load: () => Ref.get(ref),
        }),
      )
      return { ref, layer }
    })

  test("reads come back overlaid; update's f sees the RAW merged settings", async () => {
    const fSaw: string[] = []
    const program = Effect.gen(function* () {
      const { layer, ref } = yield* fakeInner(DefaultSettings)
      const wrapped = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        const got = yield* store.get()
        yield* store.update((current) => {
          // `f` must receive the un-overlaid settings: record what it saw.
          fSaw.push(current.model)
          return { ...current, theme: "one-dark" }
        })
        return got
      }).pipe(Effect.provide(smithSettingsStore(baseRun).pipe(Layer.provide(layer))))
      return { overlaid: wrapped, inner: yield* Ref.get(ref) }
    })
    const { inner, overlaid } = await Effect.runPromise(program)

    expect(overlaid.model).toBe(SMITH_MODEL_DEFAULTS.general)
    // f saw the raw stock model, NOT the smith default…
    expect(fSaw).toEqual([DefaultSettings.model])
    // …so the inner store's state carries only f's own change.
    expect(inner.theme).toBe("one-dark")
    expect(inner.model).toBe(DefaultSettings.model)
    expect(inner.codeModel).toBeUndefined()
  })
})
