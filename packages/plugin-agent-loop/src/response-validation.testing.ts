import type { Tool } from "effect/ai"
import { Array as Arr, Effect, Option, Schema } from "effect"
import type { MalformedCall } from "./response-gate.entity.js"

/** Independent decoder reference used only by the gate tests. */
/** The step's tool of that name, its own key only: `constructor` or `toString` names no tool. */
const toolNamed = (tools: Readonly<Record<string, Tool.Any>>, name: string): Option.Option<Tool.Any> =>
  Object.hasOwn(tools, name) ? Option.fromNullishOr(tools[name]) : Option.none()

/**
 * Each of a whole response's tool calls checked, in call order: None for
 * one the loop may run, else why it will not run it: a tool the step does
 * not have, parameters its tool's schema does not decode, or an id an
 * earlier call of the response has. A tool whose parameters are not a
 * Schema (a JSON Schema the toolkit passes through) checks its own. The
 * parameters decode as the toolkit decodes them, in an Effect with the
 * caller's services: a schema that decodes asynchronously, or through a
 * service, is checked like any other.
 */
export const callRejections = (
  calls: ReadonlyArray<{ readonly id?: string; readonly name: string; readonly params: unknown }>,
  tools: Readonly<Record<string, Tool.Any>>,
): Effect.Effect<ReadonlyArray<Option.Option<MalformedCall>>> => Effect.forEach(calls, (call, index): Effect.Effect<Option.Option<MalformedCall>> => call.id !== undefined && calls.slice(0, index).some((earlier) => earlier.id === call.id)
  ? Effect.succeed(Option.some({ _tag: "DuplicateId", toolName: call.name }))
  : Option.match(toolNamed(tools, call.name), {
  onNone: () => Effect.succeed(Option.some({ _tag: "NotFound", toolName: call.name })),
  onSome: (tool) => Option.match(Option.liftPredicate(tool.parametersSchema, Schema.isSchema), {
    onNone: () => Effect.succeedNone,
    onSome: (parameters) => Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(call.params as Schema.Json).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))), Effect.flatMap(Schema.decodeUnknownEffect(parameters as Schema.Decoder<unknown>))).pipe(Effect.match({
      onSuccess: () => Option.none(),
      onFailure: (error) => Option.some({ _tag: "Invalid", toolName: call.name, description: error.message }),
    })),
  }),
}), { concurrency: 1 })

/**
 * The first of a whole response's tool calls the loop will not run
 * (`callRejections`). Under the default policy none of the calls runs until
 * every one passes (the loop answers the first that does not as a malformed
 * response).
 */
export const malformedCall = (
  calls: ReadonlyArray<{ readonly id?: string; readonly name: string; readonly params: unknown }>,
  tools: Readonly<Record<string, Tool.Any>>,
): Effect.Effect<Option.Option<MalformedCall>> => callRejections(calls, tools).pipe(Effect.map((checked) => Arr.findFirst(checked, (found) => found)))
