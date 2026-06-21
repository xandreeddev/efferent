import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeHttpTransport } from "../transport/http/client.js"
import { FAKE_ROOT_CID, fakeServerLive } from "./fakeAppEnv.js"

// Config-through-the-API: the daemon owns its settings; a client reads/updates
// them over HTTP (no editing files behind the daemon's back). updateSettings is
// effective immediately (the daemon mutates its own Settings Ref).

describe("config through the Workspace API", () => {
  test("getSettings / updateSettings round-trip over the wire", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const t = makeHttpTransport("")
        const after = yield* t.updateSettings({ maxSteps: 7 })
        const reread = yield* t.getSettings()
        return { after: after.maxSteps, reread: reread.maxSteps }
      }).pipe(Effect.scoped, Effect.provide(fakeServerLive(FAKE_ROOT_CID))),
    )
    // The daemon applied + persisted the patch; a re-read reflects it.
    expect(result.after).toBe(7)
    expect(result.reread).toBe(7)
  })
})
