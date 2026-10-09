import { expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import {
  defineRunnable, runnableExecutionPort, evaluationEnvironmentPort,
  EvaluationServicesLive, EvaluationRunStore, runEvaluation, EvalId
} from "../index.js"
import { fixture } from "./fixture.testing.js"

const Input = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("echo"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("length"), text: Schema.String })
])
const Output = Schema.Union([Schema.String, Schema.Number])
const Evidence = Schema.Struct({ kind: Schema.String })
const World = Schema.Struct({ prefix: Schema.String })
const Runner = runnableExecutionPort<typeof Input.Type, typeof Output.Type, typeof Evidence.Type, typeof World.Type>("typed")
const Environment = evaluationEnvironmentPort<typeof Input.Type, typeof World.Type>("typed")
const OtherEnvironment = evaluationEnvironmentPort<typeof Input.Type, { readonly database: string }>("other")
const WrongInputEnvironment = evaluationEnvironmentPort<number, typeof World.Type>("wrong-input")
const definition = { id: EvalId.make("subject"), version: "1", description: "typed union", fingerprints: {} }
const runner = Layer.succeed(Runner, {
  execute: (input, _, world) => Effect.succeed({
    output: input.kind === "echo" ? world.prefix + input.text : input.text.length,
    evidence: { kind: input.kind }
  })
})
const environment = Layer.succeed(Environment, {
  open: () => Effect.succeed({ prefix: "hello " }),
  inspect: (world) => Effect.succeed({ state: world, references: [] })
})
const registration = defineRunnable({
  definition, input: Input, output: Output, evidence: Evidence,
  runnable: Runner, environment: Environment, layer: runner,
  environments: [{ id: "memory", layer: environment }]
})

/** These assertions run in the repository tsc gate; unused expect-error directives fail it. */
export const incompatibleWiring = () => [
  defineRunnable({
    definition, input: Input, output: Output, evidence: Evidence, runnable: Runner,
    // @ts-expect-error An environment expecting a number cannot receive this input union.
    environment: WrongInputEnvironment,
    layer: runner, environments: []
  }),
  defineRunnable({
    definition, input: Input, output: Output, evidence: Evidence, runnable: Runner,
    // @ts-expect-error An environment with a database cannot satisfy the required prefix world.
    environment: OtherEnvironment,
    layer: runner, environments: []
  }),
  defineRunnable({
    definition, input: Input, output: Output, evidence: Evidence,
    runnable: Runner, environment: Environment,
    // @ts-expect-error A layer providing an environment cannot provide the execution port.
    layer: environment, environments: []
  }),
  // @ts-expect-error The port accepts a discriminated input union, never an arbitrary string.
  Runner.of({ execute: (input: string) => Effect.succeed({ output: input, evidence: { kind: "invalid" } }) })
]
const store = Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, writeRun: () => Effect.void })

test("specific input unions and environment ports survive shared CLI dispatch", async () => {
  const base = fixture()
  const app = { ...base, runnables: [registration], suites: base.suites.map((suite) => ({
    ...suite, tasks: [
      { ...suite.tasks[0]!, id: EvalId.make("echo"), input: { kind: "echo", text: "world" } },
      { ...suite.tasks[0]!, id: EvalId.make("length"), input: { kind: "length", text: "world" } }
    ]
  })) }
  const captured = await Effect.runPromise(runEvaluation(app, "typed", { ids: [], split: "validation", executeOnly: true }).pipe(
    Effect.provide(EvaluationServicesLive(app)), Effect.provide(store)
  ))
  expect(captured.trials.map((trial) => Option.getOrThrow(trial.output))).toEqual(["hello world", 5])
  expect(captured.trials.map((trial) => Option.getOrThrow(trial.evidence))).toEqual([{ kind: "echo" }, { kind: "length" }])
})

test("malformed persisted input fails before opening the typed environment", async () => {
  const opened = await Effect.runPromise(Ref.make(0))
  const guarded = defineRunnable({
    definition, input: Input, output: Output, evidence: Evidence,
    runnable: Runner, environment: Environment, layer: runner,
    environments: [{ id: "memory", layer: Layer.succeed(Environment, {
      open: () => Ref.update(opened, (n) => n + 1).pipe(Effect.as({ prefix: "hello " })),
      inspect: () => Effect.succeed({ state: {}, references: [] })
    }) }]
  })
  const app = { ...fixture(), runnables: [guarded] }
  const captured = await Effect.runPromise(runEvaluation(app, "invalid", { ids: [], split: "validation", executeOnly: true }).pipe(
    Effect.provide(EvaluationServicesLive(app)), Effect.provide(store)
  ))
  expect(captured.trials[0]?.status).toBe("error")
  expect(await Effect.runPromise(Ref.get(opened))).toBe(0)
})

test("portable capture omits absent diagnostic fields and preserves exact request bytes", async () => {
  const Journal = Schema.Struct({ modelJournal: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) })
  const JournalRunner = runnableExecutionPort<string, string, typeof Journal.Type, typeof World.Type>("journal")
  const JournalEnvironment = evaluationEnvironmentPort<string, typeof World.Type>("journal")
  const request = '{ "messages": [{"role":"user","content":"hello"}] }\n'
  const recorded = defineRunnable({
    definition, input: Schema.String, output: Schema.String, evidence: Journal,
    runnable: JournalRunner, environment: JournalEnvironment,
    layer: Layer.succeed(JournalRunner, { execute: (input) => Effect.succeed({
      output: input,
      evidence: { modelJournal: [{ kind: "model.response", prompt: undefined, serializedInput: request }] }
    }) }),
    environments: [{ id: "memory", layer: Layer.succeed(JournalEnvironment, {
      open: () => Effect.succeed({ prefix: "" }),
      inspect: () => Effect.succeed({ state: {}, references: [] })
    }) }]
  })
  const app = { ...fixture(), runnables: [recorded] }
  const captured = await Effect.runPromise(runEvaluation(app, "journal", { ids: [], split: "validation", executeOnly: true }).pipe(
    Effect.provide(EvaluationServicesLive(app)), Effect.provide(store)
  ))
  expect(captured.trials[0]?.status).toBe("completed")
  expect(Option.getOrThrow(captured.trials[0]!.evidence)).toEqual({
    modelJournal: [{ kind: "model.response", serializedInput: request }]
  })
})
