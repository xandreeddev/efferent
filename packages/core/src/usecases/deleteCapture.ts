import { Effect } from "effect"
import { CaptureStore } from "../ports/CaptureStore.js"

export const deleteCapture = (idOrPrefix: string) =>
  Effect.gen(function* () {
    const store = yield* CaptureStore
    return yield* store.delete(idOrPrefix)
  })
