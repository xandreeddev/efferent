import type { EvaluationApp } from "@xandreed/evals"
import { Effect } from "effect"
import { cliFixture } from "./cli-fixture.testing.js"

/** A configuration whose one trial runs until it is interrupted: the subject of the signal test. */
const app = cliFixture(() => Effect.never)
const configuration: EvaluationApp = { ...app, suites: app.suites.map((suite) => ({ ...suite, timeoutMs: 60_000 })) }
export default configuration
