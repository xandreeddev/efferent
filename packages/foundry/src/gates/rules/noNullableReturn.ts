import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"

const NULLISH = ts.TypeFlags.Undefined | ts.TypeFlags.Null
const NEVERISH = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

type ExportedFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression

/** Exported function-like declarations of a source file: `export function f`
 *  and `export const f = (…) => …`. */
const exportedFunctions = (
  sourceFile: ts.SourceFile,
): ReadonlyArray<ExportedFunction> =>
  sourceFile.statements.flatMap((statement): ReadonlyArray<ExportedFunction> => {
    if (ts.isFunctionDeclaration(statement) && isExported(statement)) return [statement]
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      return statement.declarationList.declarations.flatMap((decl) =>
        decl.initializer !== undefined &&
        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ? [decl.initializer]
          : [],
      )
    }
    return []
  })

/**
 * TYPE-AWARE (the checker reads the declared OR inferred return type): an
 * exported function returning `A | undefined` / `A | null` pushes a null
 * check onto every caller — return `Option<A>` and the absence is a value.
 * This is the audit's biggest hole (32 nullable-returning functions in
 * sdk-core) made unrepresentable.
 */
export const noNullableReturn: IdiomRule = {
  id: RuleId.make("effect/no-nullable-return"),
  defaultSeverity: "error",
  description: "exported functions must not return `A | undefined` / `A | null`",
  fixHint: "return Option<A> (Option.fromNullable at the boundary); keep nullable unions for wire schemas only",
  check: ({ sourceFile, checker }) =>
    exportedFunctions(sourceFile).flatMap((fn): ReadonlyArray<RuleMatch> => {
      const signature = checker.getSignatureFromDeclaration(fn)
      if (signature === undefined) return []
      const returnType = signature.getReturnType()
      if (!returnType.isUnion()) return []
      const hasNullish = returnType.types.some((t) => (t.flags & NULLISH) !== 0)
      const hasValue = returnType.types.some((t) => (t.flags & NEVERISH) === 0)
      return hasNullish && hasValue
        ? [
            {
              node: fn,
              message: `returns \`${checker.typeToString(returnType)}\` — absence should be Option`,
            },
          ]
        : []
    }),
}
