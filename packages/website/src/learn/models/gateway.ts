// A model reached through the Vercel AI Gateway, with the learner's own key: any language model the gateway lists
// with tool use, called natively (the gateway passes tools to the provider), streamed, with what the provider counted.
// The key is sent in one header to one fixed address, and nowhere else: not in the address, not in a trace, not in the
// journal. Where it is kept is gateway-key.ts's.
import { Cause, Effect, Option, Queue, Schema, Stream } from "effect"
import { AiError } from "effect/ai"
import type { Prompt, Response, Tool } from "effect/ai"
import { endReading, GATEWAY_URL, readChunk, requestBody, startReading, chunkOf } from "./gateway-wire.ts"
import type { Reading } from "./gateway-wire.ts"
import { makeBrowserModel } from "./make.ts"
import type { LoadedModel, ModelChoice } from "./types.ts"

/** The model the gateway entry starts on: cheap, quick, and it calls tools. */
export const DEFAULT_GATEWAY_MODEL = "deepseek/deepseek-v4.1-flash-1017"

/** The longest answer one request may write: enough for a tool call or a few paragraphs, and a cap on what it costs. */
const MAX_TOKENS = 4096

/** The gateway's entry for one model. Its id names the model in every answer stored: `gateway:creator/model`. */
export const gatewayChoice = (model: string): ModelChoice => ({
  id: `gateway:${model}`,
  kind: "gateway",
  label: `${model} (gateway)`,
  blurb: "A hosted model through the Vercel AI Gateway, with your own key. What you type goes to the gateway and the model's provider, and each request costs a little from your key's credit.",
  memoryMB: 0,
  // The default model is asked of Baseten first; another provider answers when Baseten is busy.
  gateway: { model, order: model === DEFAULT_GATEWAY_MODEL ? ["baseten"] : [] },
})

/**
 * Requests of one conversation start alike, so they share a cache key: a hash of its first messages, the same for each
 * request of it and different between conversations. Opaque, so nothing about the learner or the page is sent.
 */
export const cacheKeyOf = (body: { readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: string | null }> }): string => {
  const start = body.messages.slice(0, 2).map((message) => `${message.role}:${message.content ?? ""}`).join("\n")
  let hash = 0x811c9dc5
  for (let i = 0; i < start.length; i++) hash = Math.imul(hash ^ start.charCodeAt(i), 0x01000193) >>> 0
  return `c${hash.toString(16)}`
}

/** A failure the gateway answered with, in words that say what to do, and whether the call is worth another try. */
export const failureOf = (status: number, said: string): AiError.AiError => {
  const description = said.length > 0 ? said.slice(0, 300) : `The gateway answered ${status}.`
  const reason =
    status === 401 ? new AiError.AuthenticationError({ kind: "InvalidKey", description: "The gateway refused the key: it is wrong or no longer valid. Enter it again in the model list." })
      : status === 403 ? new AiError.AuthenticationError({ kind: "InsufficientPermissions", description: "The gateway's key may not use this model." })
        : status === 402 ? new AiError.QuotaExhaustedError({})
          : status === 429 ? new AiError.RateLimitError({})
            : status >= 500 ? new AiError.InternalProviderError({ description: `The model's provider failed: ${description}` })
              : new AiError.InvalidRequestError({ description })
  return AiError.make({ module: "gateway", method: "streamText", reason })
}

/** A streamed answer's parts as one answer's: the text joined into one part, every other part as it came. */
const settled = (parts: ReadonlyArray<Response.StreamPartEncoded>): Array<Response.PartEncoded> => {
  const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
  const rest = parts.flatMap((part): Array<Response.PartEncoded> => (part.type === "tool-call" || part.type === "finish" ? [part] : []))
  return [...(text.length > 0 ? [{ type: "text" as const, text }] : []), ...rest]
}

export type Fetch = (url: string, init: { readonly method: string; readonly headers: Record<string, string>; readonly body: string; readonly signal: AbortSignal }) => Promise<globalThis.Response>

/** A failure of the answer's own stream, in words. */
const streamFailure = (description: string, retryable: boolean): AiError.AiError =>
  AiError.make({ module: "gateway", method: "streamText", reason: retryable ? new AiError.InternalProviderError({ description }) : new AiError.UnknownError({ description }) })

/** A chunk the gateway sends in place of an answer's next piece when the provider failed part way: `{ error: … }`. */
const ErrorChunk = Schema.Struct({ error: Schema.Struct({ message: Schema.optional(Schema.String) }) })
const errorIn = (data: string): Option.Option<string> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(ErrorChunk))(data), (chunk) => chunk.error.message ?? "the provider failed part way")

/** One answer: the request sent, its stream read chunk by chunk, each part handed on as it can be. */
const answer = (fetchFn: Fetch, key: string, body: string, active: Set<AbortController>) =>
  Stream.callback<Response.StreamPartEncoded, AiError.AiError>((queue) => Effect.gen(function* () {
    const abort = new AbortController()
    active.add(abort)
    let finished = false
    yield* Effect.addFinalizer(() => Effect.sync(() => { finished = true; active.delete(abort); abort.abort() }))
    const offer = (parts: ReadonlyArray<Response.StreamPartEncoded>) => { for (const part of parts) Queue.offerUnsafe(queue, part) }
    const fail = (error: AiError.AiError) => Queue.failCauseUnsafe(queue, Cause.fail(error))
    // The page's Stop aborts the request and stops the program, which ends this stream. An answer cut short must never
    // end as if it were whole (the loop would store half an answer as the answer), so an abort ends nothing by itself:
    // only if nobody stops the stream within a second does it fail, so that nothing waits on it for ever.
    abort.signal.addEventListener("abort", () => {
      setTimeout(() => { if (!finished) fail(streamFailure("The answer was stopped.", false)) }, 1000)
    })
    void (async () => {
      const response = await fetchFn(`${GATEWAY_URL}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
        signal: abort.signal,
      })
      if (!response.ok || response.body === null) {
        fail(failureOf(response.status, await response.text().catch(() => "")))
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let reading: Reading = startReading
      let rest = ""
      for (;;) {
        const { done, value } = await reader.read()
        rest += done ? decoder.decode() : decoder.decode(value, { stream: true })
        const lines = rest.split("\n")
        rest = done ? "" : lines.pop() ?? ""
        for (const line of lines) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : ""
          if (data.length === 0 || data === "[DONE]") continue
          const failedPartWay = errorIn(data)
          if (Option.isSome(failedPartWay)) {
            fail(streamFailure(`The model's provider failed part way through the answer: ${failedPartWay.value}`, true))
            return
          }
          Option.match(chunkOf(data), {
            onNone: () => {},
            onSome: (chunk) => {
              const read = readChunk(reading, chunk)
              reading = read.reading
              offer(read.parts)
            },
          })
        }
        if (done) break
      }
      if (Option.isNone(reading.finish)) {
        fail(streamFailure("The answer stopped before it was finished: the connection to the gateway ended early.", true))
        return
      }
      if (reading.finish.value === "length" && !reading.text && reading.calls.size === 0) {
        fail(streamFailure("The model used up its room for one answer before it wrote anything.", false))
        return
      }
      offer(endReading(reading))
      Queue.endUnsafe(queue)
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return
      fail(AiError.make({
        module: "gateway", method: "streamText",
        reason: new AiError.InternalProviderError({ description: `The gateway could not be reached, or refused the request (${error instanceof Error ? error.message : String(error)}). It answers a wrong key, a key past its spending limit, an unknown model and a busy provider without the headers a page needs to read why: check your connection, then the key and its limit in your Vercel dashboard, then the model.` }),
      }))
    })
  }), { bufferSize: 4096 })

/**
 * The gateway's model for `choice`. `keyOf` gives the key for each request, so a key forgotten is not used again; with
 * none the request fails in words. `fetchFn` is the browser's own, or a test's.
 */
export const loadGateway = (choice: ModelChoice, keyOf: () => Option.Option<string>, fetchFn: Fetch = (url, init) => fetch(url, init)): LoadedModel => {
  const spec = choice.gateway
  if (spec === undefined) throw new Error(`${choice.id} is not a gateway model`)
  const active = new Set<AbortController>()
  const stream = (options: { readonly prompt: Prompt.Prompt; readonly tools: ReadonlyArray<Tool.Any> }) =>
    Option.match(keyOf(), {
      onNone: () => Stream.fail(AiError.make({ module: "gateway", method: "streamText", reason: new AiError.AuthenticationError({ kind: "Unknown", description: "No AI Gateway key is kept: enter one in the gateway's card in the model list." }) })),
      onSome: (key) => {
        const draft = requestBody(options.prompt, options.tools, { model: spec.model, order: spec.order, cacheKey: "", maxTokens: MAX_TOKENS })
        return answer(fetchFn, key, JSON.stringify({ ...draft, prompt_cache_key: cacheKeyOf(draft) }), active)
      },
    })
  const model = makeBrowserModel(choice.id, {
    // An answer asked for whole is the streamed one, collected: its text joined, its calls and its finish as they came.
    generateText: (options) => Stream.runCollect(stream(options)).pipe(Effect.map(settled)),
    streamText: stream,
  }, "native")
  return {
    choice,
    model,
    // Stop: every request in flight, the chat's and a task's alike.
    interrupt: () => { for (const abort of active) abort.abort(); active.clear() },
    dispose: () => { for (const abort of active) abort.abort(); active.clear() },
  }
}
