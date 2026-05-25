import { Context, Data, type Effect } from "effect"
import type { Capture, CaptureId, NewCapture } from "../entities/Capture.js"

export class CaptureStoreError extends Data.TaggedError("CaptureStoreError")<{
  readonly cause: unknown
  readonly message: string
}> {}

export class CaptureNotFound extends Data.TaggedError("CaptureNotFound")<{
  readonly id: string
}> {}

export class CaptureAmbiguous extends Data.TaggedError("CaptureAmbiguous")<{
  readonly prefix: string
  readonly matches: number
}> {}

export class CaptureStore extends Context.Tag("@agent/core/CaptureStore")<
  CaptureStore,
  {
    readonly save: (
      input: NewCapture,
    ) => Effect.Effect<Capture, CaptureStoreError>
    readonly list: () => Effect.Effect<
      ReadonlyArray<Capture>,
      CaptureStoreError
    >
    /**
     * Lookup by full UUID (36 chars) or by an unambiguous prefix.
     * Returns CaptureNotFound on no match, CaptureAmbiguous on multiple matches.
     */
    readonly get: (
      idOrPrefix: string,
    ) => Effect.Effect<
      Capture,
      CaptureStoreError | CaptureNotFound | CaptureAmbiguous
    >
    readonly delete: (
      idOrPrefix: string,
    ) => Effect.Effect<
      void,
      CaptureStoreError | CaptureNotFound | CaptureAmbiguous
    >
  }
>() {}
