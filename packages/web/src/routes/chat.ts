import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Queue, Schema, Stream } from "effect"
import {
  type AgentHooks,
  type CaptureStore,
  ConversationId,
  type ConversationStore,
  type Llm,
  notesAgentConfig,
  renderUi,
  runAgent,
} from "@agent/core"

const sseEncode = (event: string, data: string): string => {
  // Multi-line data must repeat the `data: ` prefix per line per SSE spec.
  const lines = data.split("\n").map((line) => `data: ${line}`).join("\n")
  return `event: ${event}\n${lines}\n\n`
}

const decodeConversationId = Schema.decodeUnknown(ConversationId)

const errFrame = (err: unknown): string => {
  const tag =
    typeof err === "object" && err !== null && "_tag" in err
      ? String((err as { _tag: unknown })._tag)
      : "UnknownError"
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : "Unknown error generating response"
  const cause =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { cause: unknown }).cause
      : undefined
  console.error("[chat] stream error:", tag, message, cause)
  return sseEncode("ui-error", `${tag}: ${message}`)
}

const truncateArgs = (args: unknown): unknown => {
  const json = JSON.stringify(args)
  if (json.length > 240) return `${json.slice(0, 240)}…`
  return args
}

export const chatStreamRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, "http://placeholder")
  const prompt = url.searchParams.get("prompt") ?? ""

  if (prompt.trim() === "") {
    return HttpServerResponse.text("Missing `prompt` query parameter.", {
      status: 400,
    })
  }

  const rawCookie = request.cookies["conversation_id"]
  if (rawCookie === undefined || rawCookie.length === 0) {
    return HttpServerResponse.text("No conversation cookie.", { status: 400 })
  }

  const parsedId = yield* Effect.either(decodeConversationId(rawCookie))
  if (parsedId._tag === "Left") {
    return HttpServerResponse.text("Invalid conversation cookie.", {
      status: 400,
    })
  }
  const conversationId = parsedId.right

  // SSE frames flow through this queue. The agent's hooks enqueue
  // step frames as tool calls happen; the render pass enqueues ui
  // frames; we end with ui-done and shut the queue down.
  const queue = yield* Queue.unbounded<string>()

  type SseR = CaptureStore | Llm | ConversationStore
  const sseHooks: AgentHooks<SseR> = {
    onBeforeToolCall: (e) =>
      Queue.offer(
        queue,
        sseEncode(
          "step",
          JSON.stringify({
            type: "tool_call",
            toolName: e.toolName,
            args: truncateArgs(e.args),
          }),
        ),
      ).pipe(Effect.as({ action: "continue" as const })),
    onAfterToolCall: (e) =>
      Queue.offer(
        queue,
        sseEncode(
          "step",
          JSON.stringify({
            type: "tool_result",
            toolName: e.toolName,
            ok: e.ok,
          }),
        ),
      ).pipe(Effect.asVoid),
  }

  // Fork the agent + render work so the response stream can start
  // emitting (heartbeat / step frames) without waiting for runAgent.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const result = yield* runAgent(
        notesAgentConfig,
        conversationId,
        prompt,
        sseHooks,
      )
      yield* renderUi(prompt, result).pipe(
        Stream.runForEach((chunk) =>
          Queue.offer(queue, sseEncode("ui", chunk)),
        ),
      )
      yield* Queue.offer(queue, sseEncode("ui-done", ""))
    }).pipe(
      Effect.catchAll((err) =>
        Queue.offer(queue, errFrame(err)).pipe(Effect.asVoid),
      ),
      // Always end the queue so the HTTP stream terminates cleanly.
      Effect.ensuring(Queue.shutdown(queue)),
    ),
  )

  const body = Stream.fromQueue(queue, { shutdown: true }).pipe(
    Stream.encodeText,
  )

  return HttpServerResponse.stream(body, {
    contentType: "text/event-stream",
    headers: {
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  })
})
