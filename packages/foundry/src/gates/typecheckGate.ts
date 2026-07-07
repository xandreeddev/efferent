import { Effect, Option } from "effect"
import * as path from "node:path"
import * as ts from "typescript"
import { GateName, RuleId } from "../domain/Brands.js"
import { GateCrash } from "../domain/Errors.js"
import { Finding, SourceLocation } from "../domain/Finding.js"
import type { Gate, Workspace } from "../ports/Gate.js"
import { toWorkspacePath } from "./astWalk.js"
import { TsProject } from "./TsProject.js"

export const TYPECHECK_GATE = GateName.make("typecheck")

const severityOf = (category: ts.DiagnosticCategory): "error" | "warning" | "info" =>
  category === ts.DiagnosticCategory.Error
    ? "error"
    : category === ts.DiagnosticCategory.Warning
      ? "warning"
      : "info"

const toFinding = (diagnostic: ts.Diagnostic, rootDir: string): Finding =>
  new Finding({
    rule: RuleId.make(`ts/${diagnostic.code}`),
    severity: severityOf(diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    location: Option.gen(function* () {
      const file = yield* Option.fromNullable(diagnostic.file)
      const start = yield* Option.fromNullable(diagnostic.start)
      const { line, character } = file.getLineAndCharacterOfPosition(start)
      return new SourceLocation({
        file: toWorkspacePath(rootDir, file.fileName),
        line: line + 1,
        column: character + 1,
      })
    }),
    fixHint: Option.none(),
  })

/**
 * `ts.getPreEmitDiagnostics` on the SHARED program — no subprocess, no
 * stdout parsing, exact positions, and the parse is already paid for by
 * rank 0. Semantically the repo's `tsc --noEmit` gate.
 */
export const makeTypecheckGate = (tsconfigRel: string): Gate<TsProject> => ({
  name: TYPECHECK_GATE,
  kind: "typecheck",
  deterministic: true,
  run: (workspace: Workspace) =>
    Effect.gen(function* () {
      const tsp = yield* TsProject
      const project = yield* tsp
        .load(path.resolve(workspace.rootDir, tsconfigRel))
        .pipe(
          Effect.mapError(
            (e) => new GateCrash({ gate: TYPECHECK_GATE, message: e.message }),
          ),
        )
      return ts
        .getPreEmitDiagnostics(project.program)
        .filter(
          (d) =>
            d.file === undefined ||
            (!d.file.fileName.includes("/node_modules/") &&
              !path.relative(workspace.rootDir, d.file.fileName).startsWith("..")),
        )
        .map((d) => toFinding(d, workspace.rootDir))
    }),
})
