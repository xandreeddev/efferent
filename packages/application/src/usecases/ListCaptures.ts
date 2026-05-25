import { Effect } from "effect"
import { CaptureStore } from "@agent/core"

export const listCaptures = () =>
  Effect.gen(function* () {
    const store = yield* CaptureStore
    return yield* store.list()
  })
