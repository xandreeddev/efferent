import { Context } from "effect"
import type { TurnWriter } from "./sessions.port.js"

/** The turn admitted by a host: an agent adapter uses it without admitting or ending another. */
export class ActiveTurnWriter extends Context.Service<ActiveTurnWriter, {
  readonly writer: TurnWriter
}>()("efferent/ActiveTurnWriter") {}
