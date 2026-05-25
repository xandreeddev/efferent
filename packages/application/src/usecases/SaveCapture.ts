import { Effect } from "effect"
import { CaptureStore, type NewCapture } from "@agent/core"

export const saveCapture = (input: NewCapture) =>
  Effect.gen(function* () {
    const store = yield* CaptureStore
    return yield* store.save(input)
  })
