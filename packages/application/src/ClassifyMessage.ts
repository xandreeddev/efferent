import { Effect } from "effect"
import { Llm } from "@agent/core"

export const classifyMessage = (message: string) =>
  Effect.gen(function* () {
    const llm = yield* Llm
    return yield* llm.classify(message)
  })
