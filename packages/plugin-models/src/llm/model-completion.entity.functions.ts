import { ModelCompletionState } from "./model-completion.entity.js"

/** Only the first terminal observation owns the durable append and its ACK. */
export const claimModelCompletion = (state: ModelCompletionState): readonly [boolean, ModelCompletionState] => ModelCompletionState.match(state, {
  Open: () => [true, { _tag: "Recording" }] as const, Recording: () => [false, state] as const, Recorded: () => [false, state] as const, RecordFailed: () => [false, state] as const,
})
