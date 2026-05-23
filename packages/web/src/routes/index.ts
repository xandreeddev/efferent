import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Duration, Effect } from "effect"
import { ConversationStore } from "@agent/core"
import { shell } from "../views/shell.js"

export const indexRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const existing = request.cookies["conversation_id"]
  const html = HttpServerResponse.html(shell())
  if (existing !== undefined && existing.length > 0) {
    return html
  }
  const store = yield* ConversationStore
  const newId = yield* store.create()
  return yield* HttpServerResponse.setCookie(html, "conversation_id", newId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Duration.days(365),
  })
})
