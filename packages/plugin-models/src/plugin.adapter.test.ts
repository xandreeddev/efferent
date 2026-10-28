import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { SessionEnvironment, SettingsStore } from "@xandreed/core"
import { modelsPlugin } from "./plugin.adapter.js"

describe("models plugin setup continuity", () => {
  test("existing model selection survives; explicit plugin options win; inheritance can be disabled", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "efferent-model-setup-"))
    mkdirSync(join(workspace, ".efferent"))
    writeFileSync(join(workspace, ".efferent/config.json"), JSON.stringify({ model: "fixture:existing", fastModel: "fixture:fast" }))
    const load = (options: Record<string, unknown>) => Effect.scoped(Effect.gen(function* () {
      const seed = Context.make(SessionEnvironment, { workspace })
      const services = yield* modelsPlugin.build({ ...modelsPlugin.defaults, ...options }, Context.makeUnsafe<never>(seed.mapUnsafe))
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

describe("models plugin endpoints", () => {
  test("a configured endpoint serves the plugin's model without a key", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "efferent-model-endpoint-"))
    const seen: Array<{ path: string; auth: string | null; model: unknown }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        const body = await request.json() as { readonly model?: unknown }
        seen.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization"), model: body.model })
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "from the endpoint" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      },
    })
    const options = { model: "fixture-endpoint:tiny", inheritPrevious: false, endpoints: { "fixture-endpoint": { url: `http://127.0.0.1:${server.port}/v1` } } }
    const text = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const seed = Context.make(SessionEnvironment, { workspace })
      const services = yield* modelsPlugin.build({ ...modelsPlugin.defaults, ...options }, Context.makeUnsafe<never>(seed.mapUnsafe))
      const model = Option.getOrThrow(Context.getOption(services, LanguageModel.LanguageModel))
      return (yield* model.generateText({ prompt: "hi" })).text
    })).pipe(Effect.ensuring(Effect.sync(() => { server.stop(true); rmSync(workspace, { recursive: true, force: true }) }))))
    expect(text).toBe("from the endpoint")
    expect(seen).toEqual([{ path: "/v1/chat/completions", auth: null, model: "tiny" }])
  })
})
