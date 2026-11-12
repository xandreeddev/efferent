import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { settings } from "./settings.adapter.js"
import { Settings } from "./settings.port.js"

describe("settings", () => {
  test("provides the system text the loop and memory read, and nothing else", async () => {
    const provided = await Effect.runPromise(Effect.scoped(Effect.map(Layer.build(settings({ system: "You are a kit." })), (built) => ({
      system: built.mapUnsafe.get(Settings.key),
      keys: Array.from(built.mapUnsafe.keys()).filter((key) => !key.startsWith("effect/")),
    }))))
    expect(provided).toEqual({ system: { system: "You are a kit." }, keys: [Settings.key] })
  })
})
