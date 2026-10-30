import { TrialRecorder, type EvaluationApp } from "@xandreed/evals"
import { Effect } from "effect"
import { cliFixture } from "./cli-fixture.testing.js"

/** A configuration whose one trial records two events, then runs until it is interrupted or killed: the subject of the signal tests. */
const app = cliFixture(() => TrialRecorder.use((recorder) => recorder.record("tool.started", { tool: "lookup" }).pipe(
  Effect.andThen(recorder.record("tool.completed", { tool: "lookup", result: "found" })),
)).pipe(Effect.andThen(Effect.never)))
const configuration: EvaluationApp = { ...app, suites: app.suites.map((suite) => ({ ...suite, timeoutMs: 60_000 })) }
export default configuration
