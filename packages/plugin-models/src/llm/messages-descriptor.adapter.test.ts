import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { CurrentModelCallPolicy, modelRequestDescriptorOf, parseModelSelection } from "@xandreed/core"
import { AuthStore } from "../ports/auth-store.port.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelEndpoints } from "../ports/model-endpoints.port.js"
import { CurrentModelSettings } from "../ports/model-settings.port.js"
import type { ModelSettingsMap } from "./model-settings.entity.js"
import { LanguageModelSelectionLive } from "./router.js"

const fixture = () => {
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    requests.push(await request.json() as Record<string, unknown>)
    return new URL(request.url).pathname.endsWith("/chat/completions")
      ? Response.json({ choices: [{ finish_reason: "stop", message: { content: "fixture reply" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      : Response.json({ id: "msg_descriptor", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "fixture reply" }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
  } })
  return { requests, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const inspect = (options: {
  readonly selection: string
  readonly endpoints?: ModelEndpoints
  readonly settings?: ModelSettingsMap
  readonly local?: string
  readonly call?: boolean
  readonly reads?: Array<string>
  readonly policy?: boolean
}) => Effect.runPromise(Effect.result(Effect.gen(function* () {
  const selection = yield* Effect.fromOption(parseModelSelection(options.selection))
  const auth = Layer.succeed(AuthStore, AuthStore.of({
    all: Effect.succeed(new Map()),
    get: () => Effect.sync(() => options.reads?.push("credential")).pipe(Effect.as(options.local === undefined ? Option.none() : Option.some({ type: "local" as const, baseUrl: options.local }))),
    resolveKey: () => Effect.sync(() => options.reads?.push("key")).pipe(Effect.as(Option.none())),
    set: () => Effect.void, remove: () => Effect.void,
  }))
  const model = yield* LanguageModel.LanguageModel.pipe(
    Effect.provide(LanguageModelSelectionLive(selection, Option.none()).pipe(Layer.provide(auth))),
    Effect.provideService(CurrentModelEndpoints, options.endpoints ?? {}),
    Effect.provideService(CurrentModelSettings, options.settings ?? {}),
  )
  const descriptor = yield* modelRequestDescriptorOf(model)
  if (options.call) yield* model.generateText({ prompt: "Inspect the saved configuration." })
  return descriptor
}).pipe(Effect.provideService(CurrentModelCallPolicy, options.policy ? Option.some({ effort: "max", maxOutputTokens: 321 }) : Option.none()))))

describe("a routed Messages model's durable descriptor", () => {
  test("contains the resolved gateway controls and protocol without credential or HTTP IO", async () => {
    const reads: Array<string> = []
    const result = await inspect({ selection: "gateway:claude-haiku-5-5", reads,
      endpoints: { gateway: { api: "anthropic-messages", url: "https://gateway.example/proxy/v1/", auth: "bearer", apiKey: "descriptor-placeholder", apiVersion: "2026-10-21", betas: ["fixture-beta"] } },
      settings: { "gateway:claude-haiku-5-5": { thinking: { _tag: "Off" }, effort: "high", limits: { maxOutputTokens: 512 } } },
    })
    expect(result._tag === "Failure" ? String(result.failure) : "Success").toBe("Success")
    expect(result._tag === "Success" ? result.success : Option.none()).toEqual(Option.some({ provider: "gateway", model: "claude-haiku-5-5", settings: {
      fallback: null, policy: null, model: "claude-haiku-5-5", max_tokens: 512, output_config: { effort: "high" }, thinking: { type: "disabled" },
      promptCache: { _tag: "Auto", ttl: "5m" }, cacheControl: true,
      endpoint: { api: "anthropic-messages", url: "https://gateway.example/proxy", auth: "bearer", apiVersion: "2026-10-21", betas: ["fixture-beta"], cacheControl: true },
    } }))
    expect(reads).toEqual([])
    expect(JSON.stringify(result)).not.toContain("descriptor-placeholder")
  })

  test("records current policy precedence and the effective Adaptive binding", async () => {
    const result = await inspect({ selection: "gateway:claude-fable-5-1", policy: true,
      endpoints: { gateway: { api: "anthropic-messages", url: "https://gateway.example" } },
      settings: { "gateway:claude-fable-5-1": { effort: "xhigh", limits: { maxOutputTokens: 512 } } },
    })
    expect(result._tag === "Success" ? Option.map(result.success, (value) => value.settings) : Option.none()).toEqual(Option.some({
      fallback: null, policy: { effort: "max", maxOutputTokens: 321 }, model: "claude-fable-5-1", max_tokens: 321, output_config: { effort: "max" },
      thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } }, thinkingPrefixMismatch: "drop_block",
      promptCache: { _tag: "Auto", ttl: "5m" }, cacheControl: true,
      endpoint: { api: "anthropic-messages", url: "https://gateway.example", auth: "x-api-key", apiVersion: "2023-06-01", betas: [], cacheControl: true },
    }))
  })

  test("invalid configured Messages settings fail as request.model before credential IO", async () => {
    const reads: Array<string> = []
    const result = await inspect({ selection: "gateway:deployment-alias", reads, endpoints: { gateway: { api: "anthropic-messages", url: "https://gateway.example" } } })
    expect(result._tag === "Failure" ? result.failure._tag : "success").toBe("HarnessError")
    expect(result._tag === "Failure" && "code" in result.failure ? result.failure.code : "success").toBe("request.model")
    expect(reads).toEqual([])
  })

  test("builtin Anthropic retains resolved public defaults as a requested profile candidate", async () => {
    const result = await inspect({ selection: "anthropic:claude-opus-5-5" })
    expect(result._tag === "Success" ? Option.map(result.success, (value) => value.settings["messagesProfile"]) : Option.none()).toEqual(Option.some({
      kind: "requested", apiVersion: "2023-06-01", settings: { model: "claude-opus-5-5", max_tokens: 128_000, output_config: { effort: "medium" },
        thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } }, thinkingPrefixMismatch: "drop_block", promptCache: { _tag: "Auto", ttl: "5m" }, cacheControl: true },
    }))
  })

  test("an unknown builtin model redirected by a local credential keeps legacy chat compatibility", async () => {
    const server = fixture()
    const result = await inspect({ selection: "anthropic:deployment-alias", local: `${server.url}/v1`, call: true }).finally(server.stop)
    expect(result._tag === "Failure" ? String(result.failure) : "Success").toBe("Success")
    expect(result._tag === "Success" ? Option.map(result.success, (value) => value.settings["messagesProfile"]) : Option.none()).toEqual(Option.some({
      kind: "requested", apiVersion: "2023-06-01", controls: {}, unresolved: "OutputLimit",
    }))
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.["model"]).toBe("deployment-alias")
    expect(server.requests[0]).not.toHaveProperty("thinking")
  })

  test("a configured chat override does not claim Messages controls", async () => {
    const result = await inspect({ selection: "anthropic:deployment-alias", endpoints: { anthropic: { url: "https://gateway.example/v1" } } })
    expect(result._tag === "Success" ? result.success : Option.none()).toEqual(Option.some({ provider: "anthropic", model: "deployment-alias", settings: { fallback: null, policy: null } }))
  })
})
