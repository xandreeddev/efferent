import { Effect, Option, Schema } from "effect"
import { harnessError } from "../harness/harness-code.entity.functions.js"
import { ModelRequestHook } from "../ports/model-request-hook.port.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import { isTurnError } from "../session/sessions.entity.functions.js"
import type { TurnError } from "../session/sessions.entity.js"
import { hostNote } from "./model-text.js"
import { ModelRequestDraft, ModelRequestPatch } from "./model-request-hook.entity.js"
import type { ModelRequestPreparation } from "./model-request-hook.entity.js"

const failed = (cause: unknown): TurnError => isTurnError(cause)
  ? cause : harnessError("request.hook", "The model request hook could not be applied.", cause)
const immutable = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) return value
  Object.values(value).map(immutable)
  return Object.freeze(value)
}
const strict = { onExcessProperty: "error" } as const

/** Apply the optional execution-time host hook before a request is frozen. */
export const applyModelRequestHook = Effect.fnUntraced(function* (input: ModelRequestDraft): Effect.fn.Return<ModelRequestPreparation, TurnError> {
  return yield* Effect.gen(function* () {
    // Decode to fresh DTOs first: inherited serialization hooks or varying
    // getters cannot alter the values after validation or escape into storage.
    const normalized = yield* Schema.decodeUnknownEffect(Schema.toType(ModelRequestDraft), strict)(input)
    const encoded = yield* Schema.encodeEffect(ModelRequestDraft)(normalized)
    const json = yield* storedJson(encoded)
    const draft = immutable(yield* Schema.decodeUnknownEffect(ModelRequestDraft, strict)(json))
    const hook = yield* Effect.serviceOption(ModelRequestHook)
    if (Option.isNone(hook)) return immutable({ system: draft.system, context: draft.context, toolChoice: draft.toolChoice, hook: Option.none() })
    const output = yield* Effect.suspend(() => hook.value.prepare(draft)).pipe(Effect.interruptible)
    const patch = immutable(yield* Schema.decodeUnknownEffect(ModelRequestPatch, strict)(output))
    const choice = patch.toolChoice
    if (choice !== undefined && choice !== null && typeof choice !== "string" && !draft.activeTools.includes(choice.tool)) {
      return yield* Effect.fail(failed({ tool: choice.tool }))
    }
    const contribution = patch.context
    const context = contribution === undefined || contribution.length === 0 ? draft.context : Option.some(Option.match(draft.context, {
      onNone: () => hostNote(contribution),
      onSome: (base) => base.length === 0 ? hostNote(contribution) : `${base}\n\n${hostNote(contribution)}`,
    }))
    return immutable({
      system: patch.system === undefined ? draft.system : patch.system,
      context,
      toolChoice: choice === undefined ? draft.toolChoice : choice === null ? Option.none() : Option.some(choice),
      hook: Option.some(patch),
    })
  }).pipe(Effect.mapError(failed), Effect.catchDefect((defect) => Effect.fail(failed(defect))))
})
