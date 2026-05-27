import { createGoogleGenerativeAI } from "@ai-sdk/google"
import {
  type Content,
  type FunctionDeclaration,
  GoogleGenAI,
  type Part,
} from "@google/genai"
import { createHash } from "node:crypto"
import { Config, Context, Effect, HashMap, JSONSchema, Layer, Redacted, Ref } from "effect"
import {
  type AgentMessage,
  type AgentTool,
  Llm,
  LlmCache,
  type LlmCacheHint,
  LlmInfo,
  type LlmSnapshotInput,
} from "@agent/core"

import { buildLlm, type CacheStrategy } from "./vercelAi.js"

/**
 * Google Generative AI provider wiring.
 *
 * Two caches in play:
 *   - **Static cache** (lazy, process-lifetime): created on the first
 *     `runTurn` from `(system + tools)`. Used as the fallback when no
 *     per-conversation cache hint is set. Reused across all
 *     conversations within this LlmLive's lifetime.
 *   - **Per-conversation snapshot caches** (created on demand): the
 *     application calls `Llm.snapshot` at the end of every `runAgent`,
 *     which creates a fresh cache from `(system + tools + full
 *     conversation up through this turn)` and returns an opaque hint.
 *     The application persists the hint per conversation and passes it
 *     back via `cacheHint` on subsequent `runTurn` calls. Each turn in
 *     the next user prompt then references this bigger cache, sending
 *     only the new messages on top.
 *
 * Caches are immutable in content; "growing" the cache = creating a new
 * resource. We tolerate creation failures (content too small for the
 * model's minimum, network blip, etc.) — caching is a cost optimisation,
 * never a correctness requirement.
 */

const STRIPPED_SCHEMA_KEYS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "additionalProperties",
])

const sanitizeSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  if (typeof schema !== "object" || schema === null) return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (STRIPPED_SCHEMA_KEYS.has(k)) continue
    out[k] = sanitizeSchema(v)
  }
  return out
}

const toFunctionDeclaration = (
  t: AgentTool<any, any, any>,
): FunctionDeclaration => ({
  name: t.name,
  description: t.description,
  parameters: sanitizeSchema(JSONSchema.make(t.parameters)) as Record<
    string,
    unknown
  >,
})

/**
 * Translate domain `AgentMessage` to the Google GenAI `Content` shape
 * for `caches.create({ contents })`. Vercel SDK uses the same
 * conceptual shape but a slightly different field layout — the Google
 * SDK's `Content` is `{ role: "user" | "model" | "function", parts: Part[] }`
 * with the assistant role called "model" and tool results encoded as
 * `functionResponse` parts.
 */
const toGoogleContent = (m: AgentMessage): Content => {
  if (m.role === "user") {
    return { role: "user", parts: [{ text: m.content }] }
  }
  if (m.role === "assistant") {
    return {
      role: "model",
      parts: m.content.flatMap((part): Part[] => {
        if (part.type === "text") return [{ text: part.text }]
        if (part.type === "reasoning") {
          // Carry the provider-private signature through if present.
          const sig =
            part.providerOptions !== undefined &&
            typeof part.providerOptions === "object" &&
            part.providerOptions !== null &&
            "google" in part.providerOptions &&
            typeof (part.providerOptions as Record<string, unknown>).google ===
              "object"
              ? ((part.providerOptions as Record<string, unknown>).google as {
                  thoughtSignature?: string
                })
              : undefined
          return [
            {
              thought: true,
              text: part.text,
              ...(sig?.thoughtSignature !== undefined
                ? { thoughtSignature: sig.thoughtSignature }
                : {}),
            },
          ]
        }
        if (part.type === "tool-call") {
          return [
            {
              functionCall: {
                id: part.toolCallId,
                name: part.toolName,
                args: (part.input ?? {}) as Record<string, unknown>,
              },
            },
          ]
        }
        return []
      }),
    }
  }
  // tool
  return {
    role: "user", // Google represents tool results as user-role with functionResponse parts
    parts: m.content.map(
      (part): Part => ({
        functionResponse: {
          id: part.toolCallId,
          name: part.toolName,
          response: (typeof part.output === "object" && part.output !== null
            ? (part.output as Record<string, unknown>)
            : { result: part.output }) as Record<string, unknown>,
        },
      }),
    ),
  }
}

type GeminiCacheHint = {
  readonly cachedContent: string
  readonly skipMessages: number
}

const isGeminiHint = (h: unknown): h is GeminiCacheHint =>
  typeof h === "object" &&
  h !== null &&
  typeof (h as Record<string, unknown>).cachedContent === "string" &&
  typeof (h as Record<string, unknown>).skipMessages === "number"

/**
 * Adapter-internal services tag. One Gemini setup (provider, static
 * cache, snapshot strategy, metadata) is built once and parcelled out to
 * the three public Layers (`Llm`, `LlmCache`, `LlmInfo`) via the bundled
 * `GeminiLive` Layer below. Effect's Layer memoization ensures the
 * setup Effect runs exactly once per `GeminiLive` provision, regardless
 * of how many of the three ports the caller asks for.
 */
class GeminiServices extends Context.Tag(
  "@agent/adapters/internal/GeminiServices",
)<GeminiServices, ReturnType<typeof buildLlm>>() {}

const GeminiServicesLive = Layer.effect(
  GeminiServices,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_GENERATIVE_AI_API_KEY")
    const modelName = yield* Config.string("AGENT_MODEL").pipe(
      Config.withDefault("gemini-3.5-flash"),
    )
    const rawKey = Redacted.value(apiKey)

    // Strip `systemInstruction` / `tools` / `toolConfig` from requests
    // that carry `cachedContent` — Gemini rejects duplicates ("must come
    // from the cache"). The Vercel SDK always sends them; the cache
    // contains the right values; this just removes the dupes on the
    // wire. The SDK's in-memory `tools` (for matching tool-call
    // execution) is untouched.
    const stripDuplicateFetch = async (
      url: URL | RequestInfo,
      init?: RequestInit,
    ): Promise<Response> => {
      if (
        init?.body !== undefined &&
        typeof init.body === "string" &&
        init.body.includes('"cachedContent"')
      ) {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>
          if (body.cachedContent != null) {
            delete body.systemInstruction
            delete body.tools
            delete body.toolConfig
            init = { ...init, body: JSON.stringify(body) }
          }
        } catch {
          // body wasn't JSON we could parse; let it through unchanged
        }
      }
      return fetch(url, init)
    }

    const provider = createGoogleGenerativeAI({
      apiKey: rawKey,
      fetch: stripDuplicateFetch as typeof fetch,
    })
    const genai = new GoogleGenAI({ apiKey: rawKey })

    /**
     * Static cache keyed by content hash of `(system + tool names)`.
     * One process can drive multiple distinct (system, tools) pairs — the
     * main coder agent, scoped sub-agents, the notes flow — and each
     * needs its own provider-side cache. A single Ref<string | null>
     * (the prior shape) only worked when one pair was ever in play.
     *
     * Sentinel `""` per hash means "create failed, don't retry".
     */
    const staticCachesByContent = yield* Ref.make(HashMap.empty<string, string>())

    const cacheKeyFor = (input: { system: string; tools: ReadonlyArray<{ name: string }> }) =>
      createHash("sha1")
        .update(
          JSON.stringify({
            system: input.system,
            toolNames: input.tools.map((t) => t.name).sort(),
          }),
        )
        .digest("hex")

    const staticOptionsFor: CacheStrategy["staticOptionsFor"] = (input) =>
      Effect.gen(function* () {
        const key = cacheKeyFor(input)
        const existing = HashMap.get(yield* Ref.get(staticCachesByContent), key)
        if (existing._tag === "Some") {
          if (existing.value === "") return undefined
          return { google: { cachedContent: existing.value } }
        }

        const created = yield* Effect.tryPromise({
          try: () =>
            genai.caches.create({
              model: modelName,
              config: {
                systemInstruction: input.system,
                tools: [
                  {
                    functionDeclarations: input.tools.map(
                      toFunctionDeclaration,
                    ),
                  },
                ],
                ttl: "3600s",
                displayName: `agent-static-${modelName}-${key.slice(0, 8)}`,
              },
            }),
          catch: (cause) => cause,
        }).pipe(Effect.either)

        if (created._tag === "Left") {
          yield* Effect.logWarning(
            `[llm.cache] static create failed (key=${key.slice(0, 8)}), continuing uncached: ${String(
              created.left,
            )}`,
          )
          yield* Ref.update(staticCachesByContent, HashMap.set(key, ""))
          return undefined
        }

        const name = created.right.name ?? ""
        if (name === "") {
          yield* Ref.update(staticCachesByContent, HashMap.set(key, ""))
          return undefined
        }

        yield* Effect.log(
          `[llm.cache] static created ${name} model=${modelName} key=${key.slice(0, 8)} ttl=3600s`,
        )
        yield* Ref.update(staticCachesByContent, HashMap.set(key, name))
        return { google: { cachedContent: name } }
      })

    const snapshot = <R>(
      input: LlmSnapshotInput<R>,
    ): Effect.Effect<LlmCacheHint | undefined, never> =>
      Effect.gen(function* () {
        const contents = input.messages.map(toGoogleContent)
        const created = yield* Effect.tryPromise({
          try: () =>
            genai.caches.create({
              model: modelName,
              config: {
                systemInstruction: input.system,
                tools: [
                  {
                    functionDeclarations: input.tools.map(
                      toFunctionDeclaration,
                    ),
                  },
                ],
                contents,
                ttl: "3600s",
                displayName: `agent-conv-${modelName}`,
              },
            }),
          catch: (cause) => cause,
        }).pipe(Effect.either)

        if (created._tag === "Left") {
          yield* Effect.logWarning(
            `[llm.cache] snapshot failed, conversation continues uncached: ${String(
              created.left,
            )}`,
          )
          return undefined
        }
        const name = created.right.name ?? ""
        if (name === "") return undefined

        const hint: GeminiCacheHint = {
          cachedContent: name,
          skipMessages: input.messages.length,
        }
        yield* Effect.log(
          `[llm.cache] snapshot created ${name} messages=${input.messages.length} ttl=3600s`,
        )
        return hint as LlmCacheHint
      })

    const cacheStrategy: CacheStrategy = {
      staticOptionsFor,
      interpretHint: (hint) => (isGeminiHint(hint) ? hint : undefined),
      snapshot,
    }

    return buildLlm(provider(modelName), {
      cacheStrategy,
      modelIdOverride: modelName,
      contextWindow: 1_000_000,
    })
  }),
)

/* ------------------------------------------------------------------ */
/* Public layers — each picks a subset of methods out of the shared    */
/* services and binds them to the corresponding port. Drivers should   */
/* prefer `GeminiLive` below, which provides all three at once.        */
/* ------------------------------------------------------------------ */

const LlmFromGemini = Layer.effect(
  Llm,
  Effect.map(GeminiServices, (svc) => ({ runTurn: svc.runTurn })),
)

const LlmCacheFromGemini = Layer.effect(
  LlmCache,
  Effect.map(GeminiServices, (svc) => ({ snapshot: svc.snapshot })),
)

const LlmInfoFromGemini = Layer.effect(
  LlmInfo,
  Effect.map(GeminiServices, (svc) => ({ metadata: svc.metadata })),
)

/**
 * Smart-tier Gemini bundle: provides `Llm`, `LlmCache`, and `LlmInfo`
 * from a single shared setup (one provider, one static cache, one
 * snapshot strategy).
 */
export const GeminiLive = Layer.mergeAll(
  LlmFromGemini,
  LlmCacheFromGemini,
  LlmInfoFromGemini,
).pipe(Layer.provide(GeminiServicesLive))
