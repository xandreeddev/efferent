import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"

const isSchemaValueDeclaration = (statement: ts.Statement, name: string): boolean => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(
      (decl) =>
        ts.isIdentifier(decl.name) &&
        decl.name.text === name &&
        decl.initializer !== undefined &&
        decl.initializer.getText().startsWith("Schema."),
    )
  }
  if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
    return (statement.heritageClauses ?? []).some((clause) =>
      clause.types.some((t) => t.expression.getText().startsWith("Schema.")),
    )
  }
  return false
}

/**
 * The audit found 96 hand-written interfaces shadowing Schema declarations —
 * two sources of truth that drift. When a file declares `const X = Schema.…`
 * (or `class X extends Schema.Class`), an `interface X` beside it is the
 * drift waiting to happen: derive the type (`typeof X.Type`) instead.
 */
export const noParallelInterface: IdiomRule = {
  id: RuleId.make("effect/no-parallel-interface"),
  defaultSeverity: "error",
  description: "a hand-written interface must not shadow a same-named Schema declaration",
  fixHint: "derive the type from the schema — `export type X = typeof X.Type` — one source of truth",
  check: ({ sourceFile }) =>
    sourceFile.statements.flatMap((statement): ReadonlyArray<RuleMatch> =>
      ts.isInterfaceDeclaration(statement) &&
      sourceFile.statements.some((other) =>
        isSchemaValueDeclaration(other, statement.name.text),
      )
        ? [
            {
              node: statement,
              message: `interface \`${statement.name.text}\` shadows the Schema declaration of the same name`,
            },
          ]
        : [],
    ),
}
