import { Effect, Option } from "effect"
import * as path from "node:path"
import * as ts from "typescript"
import { GateName, RuleId } from "../domain/Brands.js"
import { GateCrash } from "../domain/Errors.js"
import { Finding, SourceLocation } from "../domain/Finding.js"
import type { EvalShapeConfig } from "../domain/Rules.js"
import type { Gate, Workspace } from "../ports/Gate.js"
import { locationOf, matchesGlob, projectSourceFiles, toWorkspacePath, walk } from "./astWalk.js"
import { TsProject } from "./TsProject.js"
import type { LoadedProject } from "./TsProject.js"

export const EVAL_SHAPE_GATE = GateName.make("eval-shape")

const NONEMPTY_SCORERS = RuleId.make("evals/nonempty-scorers")
const EXPLICIT_THRESHOLD = RuleId.make("evals/explicit-threshold")
const REGISTERED = RuleId.make("evals/registered")

const isDefineEvalCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) && node.expression.text.startsWith("defineEval")) ||
    (ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text.startsWith("defineEval")))

const propertyOf = (
  literal: ts.ObjectLiteralExpression,
  name: string,
): Option.Option<ts.PropertyAssignment> =>
  Option.fromNullable(
    literal.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
    ),
  )

const checkSuiteCall = (
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  rootDir: string,
): ReadonlyArray<Finding> => {
  const literal = call.arguments[0]
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) return []

  const scorersFindings = Option.match(propertyOf(literal, "scorers"), {
    onNone: () => [
      new Finding({
        rule: NONEMPTY_SCORERS,
        severity: "error",
        message: "suite declares NO scorers — it would silently score 0",
        location: Option.some(locationOf(sourceFile, call, rootDir)),
        fixHint: Option.some("a suite must judge something: add at least one scorer"),
      }),
    ],
    onSome: (prop) =>
      ts.isArrayLiteralExpression(prop.initializer) && prop.initializer.elements.length === 0
        ? [
            new Finding({
              rule: NONEMPTY_SCORERS,
              severity: "error",
              message: "`scorers: []` — an empty scorer list silently scores 0",
              location: Option.some(locationOf(sourceFile, prop, rootDir)),
              fixHint: Option.some("add at least one scorer (or delete the suite)"),
            }),
          ]
        : [],
  })

  const thresholdFindings = Option.match(propertyOf(literal, "threshold"), {
    onNone: () => [
      new Finding({
        rule: EXPLICIT_THRESHOLD,
        severity: "error",
        message: "suite declares no `threshold` — the pass bar must be explicit in source",
        location: Option.some(locationOf(sourceFile, call, rootDir)),
        fixHint: Option.some("declare `threshold` (0..1); a default hides the real gate"),
      }),
    ],
    onSome: () => [],
  })

  return [...scorersFindings, ...thresholdFindings]
}

/** Absolute paths of every module the registry file imports (relative
 *  specifiers only, `.js` mapped to `.ts`). */
const registryImports = (registry: ts.SourceFile): ReadonlySet<string> =>
  new Set(
    registry.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".")
        ? [
            path.resolve(
              path.dirname(registry.fileName),
              statement.moduleSpecifier.text.replace(/\.js$/, ".ts"),
            ),
          ]
        : [],
    ),
  )

const checkRegistration = (
  suites: ReadonlyArray<ts.SourceFile>,
  project: LoadedProject,
  config: EvalShapeConfig,
  rootDir: string,
): ReadonlyArray<Finding> => {
  const registryAbs = path.resolve(rootDir, config.registry)
  return Option.match(Option.fromNullable(project.program.getSourceFile(registryAbs)), {
    onNone: () => [
      new Finding({
        rule: REGISTERED,
        severity: "error",
        message: `suite registry not found in the program: ${config.registry}`,
        location: Option.none(),
        fixHint: Option.some("point evalShape.registry at the module that lists every suite"),
      }),
    ],
    onSome: (registry) => {
      const imported = registryImports(registry)
      return suites
        .filter((sf) => path.resolve(sf.fileName) !== registryAbs)
        .filter((sf) => !imported.has(path.resolve(sf.fileName)))
        .map(
          (sf) =>
            new Finding({
              rule: REGISTERED,
              severity: "error",
              message: `suite is not registered in ${config.registry} — it would silently never run`,
              location: Option.some(
                new SourceLocation({
                  file: toWorkspacePath(rootDir, sf.fileName),
                  line: 1,
                  column: 1,
                }),
              ),
              fixHint: Option.some("import the suite from the registry module"),
            }),
        )
    },
  })
}

/**
 * Eval STRUCTURE as a gate — the three holes the v1 framework leaves open,
 * each made a failure: no/empty scorers (silent 0), missing threshold
 * (decorative pass bar), unregistered suite (silently never runs).
 */
export const makeEvalShapeGate = (
  config: EvalShapeConfig,
  tsconfigRel: string,
): Gate<TsProject> => ({
  name: EVAL_SHAPE_GATE,
  kind: "static",
  deterministic: true,
  run: (workspace: Workspace) =>
    Effect.gen(function* () {
      const tsp = yield* TsProject
      const project = yield* tsp
        .load(path.resolve(workspace.rootDir, tsconfigRel))
        .pipe(
          Effect.mapError(
            (e) => new GateCrash({ gate: EVAL_SHAPE_GATE, message: e.message }),
          ),
        )
      const suites = projectSourceFiles(project, workspace.rootDir).filter((sf) =>
        matchesGlob(config.suiteGlob, toWorkspacePath(workspace.rootDir, sf.fileName)),
      )
      const shapeFindings = suites.flatMap((sf) => {
        const findings: Array<Finding> = []
        walk(sf, (node) => {
          if (isDefineEvalCall(node)) {
            findings.push(...checkSuiteCall(node, sf, workspace.rootDir))
          }
        })
        return findings
      })
      return [
        ...shapeFindings,
        ...checkRegistration(suites, project, config, workspace.rootDir),
      ]
    }),
})
