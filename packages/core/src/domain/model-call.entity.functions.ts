import { Effect } from "effect"
import type { ModelCallData } from "./model-call.entity.js"
import type { TurnError } from "../session/sessions.entity.js"
import { CurrentModelCallRecorder } from "../ports/model-call-recorder.port.js"
import { harnessError } from "../harness/harness-code.entity.functions.js"
import { isTurnError } from "../session/sessions.entity.functions.js"

/** Record one terminal attempt through the execution-time recorder. @public */
export const recordCompletion = Effect.fnUntraced(function* (data: ModelCallData): Effect.fn.Return<void, TurnError> {
  const recorder = yield* CurrentModelCallRecorder
  yield* Effect.suspend(() => recorder.record(data)).pipe(
    Effect.catchDefect((defect) => Effect.fail(isTurnError(defect)
      ? defect
      : harnessError("turn.defect", "The model call could not be recorded.", defect))),
  )
})
