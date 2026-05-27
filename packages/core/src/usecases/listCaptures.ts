import { Effect } from "effect"
import { CaptureStore } from "../ports/CaptureStore.js"

export const listCaptures = () =>
  Effect.gen(function* () {
    const store = yield* CaptureStore
    return yield* store.list()
  })
