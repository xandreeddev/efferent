import { Effect, Option, Ref, Result, Schema } from "effect"
import type { ModelsFetch } from "../ports/models-transport.port.js"
import type { ScriptedRequest, ScriptedRequestRecord, ScriptedStep } from "./scripted-chat.entity.js"
import { completionBody, pickStep, refusalBody, refusalMessage, remainingSteps, streamEvents } from "./scripted-chat.entity.functions.js"

/**
 * A scripted OpenAI-compatible endpoint: a `fetch` to build the compat
 * client or the models plugin over, and what it has seen.
 *
 * @public
 */
export interface ScriptedChatCompletions {
  /** Answers each request from the script; give it as `ModelsTransport`'s `fetch` or a compat client's `fetchImpl`. */
  readonly fetch: ModelsFetch
  /** Every request received, in order, with the step that answered it. */
  readonly requests: Effect.Effect<ReadonlyArray<ScriptedRequestRecord>>
  /** The steps still available, by their position in the script (a `repeat` step stays): empty once every step has answered. */
  readonly remaining: Effect.Effect<ReadonlyArray<number>>
}

interface ScriptState {
  readonly used: ReadonlyArray<number>
  readonly requests: ReadonlyArray<ScriptedRequestRecord>
}

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject))
const encoder = new TextEncoder()

/** A body as text: a string as it is, any other body read the way fetch would send it. */
const bodyText = (body: RequestInit["body"]) => Effect.tryPromise({
  try: () => new Response(body ?? null).text(),
  catch: (cause) => new Error("scripted chat completions: the request body could not be read", { cause }),
})

/** A streamed reply: one SSE event per chunk, each sent after its step's `beforeChunk`, until the reader stops or the request is aborted. */
const streamed = (events: ReadonlyArray<string>, step: ScriptedStep, signal: AbortSignal | undefined): Response => {
  const lifetime = new AbortController()
  const cursor = { next: 0, closed: false, pending: Promise.resolve(), controller: Option.none<ReadableStreamDefaultController<Uint8Array>>() }
  const finish = () => {
    cursor.closed = true
    lifetime.abort()
    signal?.removeEventListener("abort", abort)
  }
  const abort = () => {
    if (!cursor.closed) Option.match(cursor.controller, { onNone: () => undefined, onSome: (controller) => controller.error(signal?.reason) })
    finish()
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) finish()
  return new Response(new ReadableStream<Uint8Array>({
    start: (controller) => { cursor.controller = Option.some(controller); if (signal?.aborted) controller.error(signal.reason) },
    pull: (controller) => {
      if (cursor.closed) { controller.close(); return }
      cursor.pending = Effect.runPromiseExit(Effect.gen(function* () {
        const at = cursor.next
        yield* step.beforeChunk === undefined ? Effect.void : step.beforeChunk(at)
        if (cursor.closed) return
        cursor.next = at + 1
        controller.enqueue(encoder.encode(events[at] ?? ""))
        if (cursor.next < events.length) return
        controller.close()
        finish()
      }), { signal: lifetime.signal }).then((exit) => {
        if (exit._tag === "Failure" && !cursor.closed) { controller.error(exit.cause); finish() }
      })
      return cursor.pending
    },
    cancel: () => { finish(); return cursor.pending },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })
}

/**
 * A chat-completions endpoint that answers from `script`, in the process:
 * the production compat client (and the models plugin over it) runs with no
 * key and no network. Each request takes the first available step whose
 * `when` accepts it (`ScriptedStep`); a request that asked to stream gets
 * the reply as `data:` chunks (text and each call's arguments in fragments,
 * the usage on the final chunk, then `[DONE]`), one that did not gets a
 * settled body. A request no step answers (its body is not JSON, no step
 * matches, a `when` throws) is answered with HTTP 400 and an OpenAI error
 * whose message names the request and the steps left, which the client
 * fails on at once as an invalid request, never retrying it. Every request
 * is recorded (`requests`), answered or not. An aborted request's fetch
 * rejects, and its stream stops, with the signal's reason.
 *
 * @public
 */
export const scriptedChatCompletions = (script: ReadonlyArray<ScriptedStep>): ScriptedChatCompletions => {
  const state = Ref.makeUnsafe<ScriptState>({ used: [], requests: [] })
  const answer = (input: string | URL, init: RequestInit | undefined) => Effect.gen(function* () {
    const signal = init?.signal ?? undefined
    if (signal?.aborted === true) return yield* Effect.fail(signal.reason)
    const body = decodeBody(yield* bodyText(init?.body))
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    const outcome = yield* Ref.modify(state, (current) => {
      const request: ScriptedRequest = {
        index: current.requests.length,
        url: String(input),
        headers,
        body: Option.getOrElse(body, () => ({})),
        stream: Option.exists(body, (found) => found["stream"] === true),
      }
      const picked = Option.map(body, () => pickStep(script, current.used, request))
      const step = Option.flatMap(picked, Result.getSuccess)
      const used = Option.match(step, { onNone: () => current.used, onSome: (index) => [...current.used, index] })
      return [{ request, picked }, { used, requests: [...current.requests, { ...request, step }] }] as const
    })
    const remaining = remainingSteps(script, (yield* Ref.get(state)).used)
    return Option.match(Option.flatMap(outcome.picked, Result.getSuccess), {
      onNone: () => Response.json(refusalBody(refusalMessage(outcome.request, Option.flatMap(outcome.picked, Result.getFailure), remaining)), { status: 400 }),
      onSome: (index) => {
        const step = script[index]!
        return outcome.request.stream ? streamed(streamEvents(outcome.request, step), step, signal) : Response.json(completionBody(outcome.request, step))
      },
    })
  })
  return {
    fetch: (input, init) => Effect.runPromise(answer(input, init)),
    requests: Ref.get(state).pipe(Effect.map((current) => current.requests)),
    remaining: Ref.get(state).pipe(Effect.map((current) => remainingSteps(script, current.used))),
  }
}
