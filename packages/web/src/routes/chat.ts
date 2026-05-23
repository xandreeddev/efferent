import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Stream } from "effect"
import { renderUi } from "@agent/application"
import type { CaptureStore, Llm } from "@agent/core"

const sseEncode = (event: string, data: string): string => {
  // Multi-line data must repeat the `data: ` prefix per line per SSE spec.
  const lines = data.split("\n").map((line) => `data: ${line}`).join("\n")
  return `event: ${event}\n${lines}\n\n`
}

export const chatStreamRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const runtime = yield* Effect.runtime<Llm | CaptureStore>()
  const url = new URL(request.url, "http://placeholder")
  const prompt = url.searchParams.get("prompt") ?? ""

  if (prompt.trim() === "") {
    return HttpServerResponse.text("Missing `prompt` query parameter.", {
      status: 400,
    })
  }

  const body = renderUi(prompt).pipe(
    Stream.provideContext(runtime.context),
    Stream.map((chunk) => sseEncode("ui", chunk)),
    Stream.concat(Stream.succeed(sseEncode("ui-done", ""))),
    Stream.catchAll((err) =>
      Stream.succeed(
        sseEncode(
          "ui-error",
          err._tag === "LlmError" || err._tag === "CaptureStoreError"
            ? `${err._tag}: ${err.message}`
            : "Unknown error generating UI",
        ),
      ),
    ),
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
