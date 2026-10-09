import { Effect } from "effect"
import { EvaluationError } from "../domain/identity.entity.js"
import type { EvaluationApp } from "./evaluation-app.contract.js"

export const defineEvaluationApp = (
  application: EvaluationApp
): EvaluationApp => application
export const validateEvaluationApp = (app: EvaluationApp) => {
  const registries = [
    app.suites,
    app.calibrations,
    app.runnables.map((value) => value.definition),
    app.graders.map((value) => value.definition),
    app.projections.map((value) => value.definition),
    app.suites.concat(app.calibrations.map((entry) => entry.suite)),
    ...app.runnables.map((value) => value.environments)
  ]
  const invalid =
    !app.id.trim() ||
    registries.some(
      (entries) =>
        new Set(entries.map((entry) => entry.id)).size !== entries.length
    ) ||
    app.suites
      .concat(app.calibrations.map((entry) => entry.suite))
      .some(
        (suite) =>
          suite.tasks.length === 0 ||
          suite.candidates.length === 0 ||
          new Set(suite.tasks.map((task) => task.id)).size !==
            suite.tasks.length ||
          new Set(suite.candidates.map((candidate) => candidate.id)).size !==
            suite.candidates.length ||
          suite.tasks.some(
            (task) =>
              task.graders.length === 0 ||
              new Set(task.graders.map((binding) => `${binding.grader}/${binding.scope}`)).size !== task.graders.length ||
              suite.tasks.some((other) => other.dataset === task.dataset && other.family === task.family && other.split !== task.split) ||
              !app.runnables.some(
                (runnable) => runnable.definition.id === task.runnable
              ) ||
              !app.runnables.find((runnable) => runnable.definition.id === task.runnable)?.environments.some(
                (environment) => environment.id === app.environmentFor[task.runnable]
              ) ||
              task.graders.some(
                (binding) =>
                  !app.graders.some(
                    (grader) =>
                      `${grader.definition.id}@${grader.definition.version}` ===
                      binding.grader
                  ) ||
                  !app.projections.some(
                    (projection) =>
                      projection.definition.id === binding.projection
                  )
              )
          ) ||
          suite.gates.some(
            (gate) =>
              !suite.tasks.some((task) => task.graders.some((binding) => binding.grader === gate.grader)) ||
              !app.graders.some(
                (grader) =>
                  `${grader.definition.id}@${grader.definition.version}` ===
                    gate.grader &&
                  grader.definition.metrics.includes(gate.metric)
              )
          )
      )
  return invalid
    ? Effect.fail(
        new EvaluationError({
          code: "invalid",
          message:
            "Application needs unique registrations, tasks and candidates, registered environments, and bound grader metrics"
        })
      )
    : Effect.succeed(app)
}
