import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import {
  DefaultSettings,
  SettingsStore,
  type ConversationId,
  type ModelInfo,
  type Settings,
} from "@xandreed/sdk-core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { createTuiStore, type TuiStore } from "../state/store.js"
import { applyRoleModelSelection } from "./model.js"
import { applySetting } from "./settings.js"

const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId
const newStore = (): TuiStore =>
  createTuiStore({
    status: { modelId: "m", cwd: "/work", storage: "sqlite" },
    conversationId: cid,
    footer: "f",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1000 } },
  })

/** An in-memory SettingsStore: same update-then-get contract as the real one. */
const stubSettings = (initial: Partial<Settings> = {}) => {
  const ref = Ref.unsafeMake<Settings>({ ...DefaultSettings, ...initial })
  const layer = Layer.succeed(
    SettingsStore,
    SettingsStore.of({
      get: () => Ref.get(ref),
      update: (f: (s: Settings) => Settings) => Ref.updateAndGet(ref, f),
    } as never),
  )
  return { ref, layer }
}

const run = <A>(eff: Effect.Effect<A, never, SettingsStore>, layer: Layer.Layer<SettingsStore>) =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A>)

describe("role model configuration", () => {
  const flash: ModelInfo = {
    provider: "google",
    modelId: "gemini-3.5-flash",
    displayName: "flash",
    contextWindow: 1_000_000,
  }

  test(":set fastModel persists and flips the status roles readout", async () => {
    const store = newStore()
    const { ref, layer } = stubSettings()
    await run(applySetting(store, "fastModel", "google:gemini-3.5-flash"), layer)
    const s = await Effect.runPromise(Ref.get(ref))
    expect(s.fastModel).toBe("google:gemini-3.5-flash")
    expect(store.status().roles?.find((r) => r.role === "fast")).toMatchObject({
      modelId: "gemini-3.5-flash",
      configured: true,
    })
  })

  test("a bad role value is rejected with the usage hint", async () => {
    const store = newStore()
    const { ref, layer } = stubSettings()
    await run(applySetting(store, "fastModel", "not-a-selection"), layer)
    const s = await Effect.runPromise(Ref.get(ref))
    expect(s.fastModel).toBeUndefined()
    const err = store.blocks().find((b) => b.kind === "error")
    expect(err).toBeDefined()
  })

  test(":set unknown role key is rejected", async () => {
    const store = newStore()
    const { ref, layer } = stubSettings()
    await run(applySetting(store, "cheapModel", "openai:gpt-5.4-nano"), layer)
    const s = await Effect.runPromise(Ref.get(ref))
    expect((s as Record<string, unknown>).cheapModel).toBeUndefined()
    const err = store.blocks().find((b) => b.kind === "error")
    expect(err).toBeDefined()
  })

  test("the role picker's submit persists (and null = follow general again)", async () => {
    const store = newStore()
    const { ref, layer } = stubSettings()
    await run(applyRoleModelSelection(store, "fast", flash), layer)
    expect((await Effect.runPromise(Ref.get(ref))).fastModel).toBe("google:gemini-3.5-flash")
    expect(store.status().roles?.find((r) => r.role === "fast")).toMatchObject({
      modelId: "gemini-3.5-flash",
      configured: true,
    })
    await run(applyRoleModelSelection(store, "fast", null), layer)
    expect((await Effect.runPromise(Ref.get(ref))).fastModel).toBeUndefined()
    // cleared → fast follows general again (configured: false)
    expect(store.status().roles?.find((r) => r.role === "fast")?.configured).toBe(false)
  })

  test("the code role picker persists to codeModel", async () => {
    const store = newStore()
    const { ref, layer } = stubSettings()
    await run(applyRoleModelSelection(store, "code", flash), layer)
    expect((await Effect.runPromise(Ref.get(ref))).codeModel).toBe("google:gemini-3.5-flash")
    expect(store.status().roles?.find((r) => r.role === "code")).toMatchObject({
      modelId: "gemini-3.5-flash",
      configured: true,
    })
  })
})
