import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Schema, Stream } from "effect"
import { renderUi, runAgent } from "@agent/application"
import {
  ConversationId,
  type CaptureStore,
  type ConversationStore,
  type Llm,
} from "@agent/core"

const sseEncode = (event: string, data: string): string => {
  // Multi-line data must repeat the `data: ` prefix per line per SSE spec.
  const lines = data.split("\n").map((line) => `data: ${line}`).join("\n")
  return `event: ${event}\n${lines}\n\n`
}

const decodeConversationId = Schema.decodeUnknown(ConversationId)

export const chatStreamRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const runtime = yield* Effect.runtime<Llm | CaptureStore | ConversationStore>()
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

  // Two-pass: (1) await runAgent → (2) stream renderUi over its result.
  const body = Stream.unwrap(
    Effect.gen(function* () {
      const agentResult = yield* runAgent(conversationId, prompt)
      return renderUi(prompt, agentResult)
    }),
  ).pipe(
    Stream.provideContext(runtime.context),
    Stream.map((chunk) => sseEncode("ui", chunk)),
    Stream.concat(Stream.succeed(sseEncode("ui-done", ""))),
    Stream.catchAll((err: unknown) => {
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
      // Surface cause to server logs for triage; SSE keeps it terse.
      console.error("[chat] stream error:", tag, message, cause)
      return Stream.succeed(sseEncode("ui-error", `${tag}: ${message}`))
    }),
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
