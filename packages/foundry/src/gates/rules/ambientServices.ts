import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { isMemberOf, matchesIn } from "./syntax.js"

/** The process environment is an input the types do not show: read it
 *  through `Config`, and a test or host supplies it with a ConfigProvider. */
export const noProcessEnv: IdiomRule = {
  id: RuleId.make("effect/no-process-env"),
  defaultSeverity: "error",
  description: "the environment is read through `Config`; only the process edge reads `process.env`",
  fixHint:
    "read the variable with `Config` (`Config.String(name)`, `Config.Redacted(name)`, `Config.option`) so a ConfigProvider can supply it; only a `main.ts` edge, or an adapter the profile names, reads `process.env` itself",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "process", ["env"])
        ? [{ node, message: "`process.env` is an ambient dependency the types do not show" }]
        : [],
    ),
}

const ambientMatch = (node: ts.Node): ReadonlyArray<RuleMatch> => {
  if (isMemberOf(node, "Date", ["now"])) return [{ node, message: "`Date.now` reads the wall clock" }]
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && (node.arguments ?? []).length === 0) {
    return [{ node, message: "`new Date()` reads the wall clock" }]
  }
  if (isMemberOf(node, "Math", ["random"])) return [{ node, message: "`Math.random` is a generator no seed or test controls" }]
  if (
    (ts.isPropertyAccessExpression(node) && node.name.text === "randomUUID") ||
    (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "randomUUID")
  ) {
    return [{ node, message: "`randomUUID` is a generator no seed or test controls" }]
  }
  return []
}

/** Time and randomness are services: `Clock` and `Random` are what a
 *  TestClock or a seed replaces, so code reading them stays repeatable. */
export const noAmbientTimeRandom: IdiomRule = {
  id: RuleId.make("effect/no-ambient-time-random"),
  defaultSeverity: "error",
  description: "time comes from `Clock` and randomness from `Random`, outside adapters",
  fixHint:
    "read the time with `Clock.currentTimeMillis` (or `DateTime.now`) and draw from `Random`, so a TestClock or a seed drives them; only an adapter (`*.adapter.ts`) touches the platform clock and generator",
  check: ({ sourceFile }) => matchesIn(sourceFile, ambientMatch),
}
