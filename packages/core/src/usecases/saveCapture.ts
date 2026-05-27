import { Effect } from "effect"
import { CaptureStore } from "../ports/CaptureStore.js"
import type { NewCapture } from "../entities/Capture.js"

export const saveCapture = (input: NewCapture) =>
  Effect.gen(function* () {
    const store = yield* CaptureStore
    return yield* store.save(input)
  })
