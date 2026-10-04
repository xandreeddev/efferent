import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AuthStore, ModelCatalog, ProviderId } from "@xandreed/core"
import { ConfiguredModelCatalogLive, LocalAuthStoreLive } from "@xandreed/plugin-models"
import { Effect, Fiber, Layer, Option, Schedule } from "effect"
import type { HarnessError } from "@xandreed/core"
import { ConversationId } from "@xandreed/core"
import { createTuiState } from "@xandreed/tui"
import { loginCommand } from "./login.js"

const temporary: string[] = []
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

describe("terminal subscription login", () => {
  test("Vercel selection saves a masked gateway key and exposes its Flash model", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "efferent-vercel-login-")); temporary.push(workspace)
    const auth = LocalAuthStoreLive(workspace, workspace, ".efferent/runtime", ".efferent")
    const state = createTuiState({ id: ConversationId.make("00000000-0000-4000-8000-000000000001"), profile: "smith", workspace, createdAt: 0 })
    const effects: Array<Effect.Effect<void, HarnessError>> = []
    const connected: string[] = []
    const command = loginCommand(workspace, workspace, (_state, effect) => effects.push(effect), () => Effect.sync(() => { connected.push("ready") }))
    await Effect.runPromise(command.run("", state))
    const providers = state.overlay()
    if (providers.kind !== "menu") return expect(String(providers.kind)).toBe("menu")
    const gateway = providers.rows.find((row) => row.label === "vercel")
    expect(gateway?.detail).toBe("Vercel AI Gateway")
    gateway!.select()
    const methods = state.overlay()
    if (methods.kind !== "menu") return expect(String(methods.kind)).toBe("menu")
    expect(methods.rows.map((row) => row.label)).toEqual(["API key"])
    methods.rows[0]!.select()
    const editor = state.overlay()
    if (editor.kind !== "edit") return expect(String(editor.kind)).toBe("edit")
    expect(editor.secret).toBe(true)
    expect(connected).toEqual([])
    editor.save("  fixture-gateway-key  ")
    await Effect.runPromise(effects[0]!)
    expect(connected).toEqual(["ready"])
    expect(state.overlay().kind).toBe("none")
    expect(state.notice()).toContain("/model vercel:deepseek/deepseek-v4.1-flash")
    const credential = await Effect.runPromise(AuthStore.pipe(Effect.flatMap((store) => store.get(ProviderId.make("vercel"))), Effect.provide(auth)))
    expect(Option.isSome(credential) && credential.value).toEqual({ type: "api_key", key: "fixture-gateway-key" })
    const catalog = await Effect.runPromise(ModelCatalog.pipe(Effect.flatMap((models) => models.list), Effect.provide(ConfiguredModelCatalogLive.pipe(Layer.provide(auth)))))
    expect(catalog.find((entry) => entry.selection === "vercel:deepseek/deepseek-v4.1-flash")?.label).toBe("DeepSeek Flash V4.1 · Vercel AI Gateway")
    expect(catalog.some((entry) => entry.provider === "opencode")).toBe(false)
  })
  test("setup continues to model selection only after a key is saved", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "efferent-login-")); temporary.push(workspace)
    const state = createTuiState({ id: ConversationId.make("00000000-0000-4000-8000-000000000001"), profile: "smith", workspace, createdAt: 0 })
    const effects: Array<Effect.Effect<void, HarnessError>> = []
    const command = loginCommand(workspace, workspace, (_state, effect) => { effects.push(effect) }, () => Effect.sync(() => state.setOverlay({ kind: "menu", title: "Choose a model", rows: [] })))
    await Effect.runPromise(command.run("google", state))
    const methods = state.overlay()
    if (methods.kind !== "menu") return expect(String(methods.kind)).toBe("menu")
    methods.rows[0]!.select()
    const editor = state.overlay()
    if (editor.kind !== "edit") return expect(String(editor.kind)).toBe("edit")
    expect(editor.secret).toBe(true)
    editor.save("")
    expect((await Effect.runPromise(Effect.result(effects[0]!)))._tag).toBe("Failure")
    expect(state.overlay().kind).toBe("edit")
    editor.save("test-local-key")
    await Effect.runPromise(effects[1]!)
    const next = state.overlay()
    expect(next.kind === "menu" && next.title).toBe("Choose a model")
    const credential = await Effect.runPromise(AuthStore.pipe(Effect.flatMap((store) => store.get(ProviderId.make("google"))), Effect.provide(LocalAuthStoreLive(workspace, workspace, ".efferent/runtime"))))
    expect(Option.isSome(credential) && credential.value.type).toBe("api_key")
  })
  test("rejects a mismatched callback state and closes its listener when cancelled", async () => {
    const state = createTuiState({ id: ConversationId.make("00000000-0000-4000-8000-000000000001"), profile: "smith", workspace: "/tmp", createdAt: 0 })
    const effects: Array<Effect.Effect<void, HarnessError>> = []
    const command = loginCommand("/tmp", "/tmp", (_state, effect) => { effects.push(effect) })
    await Effect.runPromise(command.run("openai", state))
    const methods = state.overlay()
    if (methods.kind !== "menu") return expect(String(methods.kind)).toBe("menu")
    methods.rows[1]!.select()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effects[0]!)
      yield* Effect.repeat(Effect.sync(() => state.overlay()), { schedule: Schedule.spaced("1 millis"), until: (overlay) => overlay.kind === "menu" && overlay.title === "Connect openai subscription" })
      const overlay = state.overlay()
      if (overlay.kind !== "menu") return yield* Effect.die("Missing subscription menu")
      const authorize = new URL(overlay.rows[0]!.detail)
      const callback = authorize.searchParams.get("redirect_uri")!
      const response = yield* Effect.promise(() => fetch(`${callback}?code=test&state=wrong`))
      expect(response.status).toBe(400)
      state.setOverlay({ kind: "none" })
      yield* Fiber.join(fiber)
      const closed = yield* Effect.tryPromise({ try: () => fetch(callback), catch: () => "closed" }).pipe(Effect.result)
      expect(closed._tag).toBe("Failure")
    })))
  })
})
