import { HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { shell } from "../views/shell.js"

export const indexRoute = Effect.succeed(HttpServerResponse.html(shell()))
