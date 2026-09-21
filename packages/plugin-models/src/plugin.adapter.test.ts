import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Option } from "effect"
import { SessionEnvironment, SettingsStore } from "@xandreed/core"
import { modelsPlugin } from "./plugin.adapter.js"

describe("models plugin setup continuity", () => {
  test("existing model selection survives; explicit plugin options win; inheritance can be disabled", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "efferent-model-setup-"))
    mkdirSync(join(workspace, ".efferent"))
    writeFileSync(join(workspace, ".efferent/config.json"), JSON.stringify({ model: "fixture:existing", fastModel: "fixture:fast" }))
    const load = (options: Record<string, unknown>) => Effect.scoped(Effect.gen(function* () {
      const seed = Context.make(SessionEnvironment, { workspace })
      const services = yield* modelsPlugin.build({ ...modelsPlugin.defaults, ...options }, Context.unsafeMake<never>(seed.unsafeMap))
      return yield* Option.getOrThrow(Context.getOption(services, SettingsStore)).load
    }))
    await Effect.runPromise(Effect.gen(function* () {
      const inherited = yield* load({})
      expect(Option.getOrThrow(inherited.model)).toBe("fixture:existing")
      expect(Option.getOrThrow(inherited.fastModel)).toBe("fixture:fast")
      expect(Option.getOrThrow((yield* load({ model: "fixture:override" })).model)).toBe("fixture:override")
      expect(Option.isNone((yield* load({ inheritPrevious: false })).model)).toBe(true)
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })
})
