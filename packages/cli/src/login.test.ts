import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AuthStore, ProviderId } from "@xandreed/core"
import { LocalAuthStoreLive } from "@xandreed/plugin-models"
import { Effect, Fiber, Option, Schedule } from "effect"
import type { HarnessError } from "@xandreed/core"
import { ConversationId } from "@xandreed/core"
import { createTuiState } from "@xandreed/tui"
import { loginCommand } from "./login.js"

const temporary: string[] = []
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

describe("terminal subscription login", () => {
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
    expect((await Effect.runPromise(Effect.either(effects[0]!)))._tag).toBe("Left")
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
      const fiber = yield* Effect.fork(effects[0]!)
      yield* Effect.repeat(Effect.sync(() => state.overlay()), { schedule: Schedule.spaced("1 millis"), until: (overlay) => overlay.kind === "menu" && overlay.title === "Connect openai subscription" })
      const overlay = state.overlay()
      if (overlay.kind !== "menu") return yield* Effect.die("Missing subscription menu")
      const authorize = new URL(overlay.rows[0]!.detail)
      const callback = authorize.searchParams.get("redirect_uri")!
      const response = yield* Effect.promise(() => fetch(`${callback}?code=test&state=wrong`))
      expect(response.status).toBe(400)
      state.setOverlay({ kind: "none" })
      yield* Fiber.join(fiber)
      const closed = yield* Effect.tryPromise({ try: () => fetch(callback), catch: () => "closed" }).pipe(Effect.either)
      expect(closed._tag).toBe("Left")
    })))
  })
})
