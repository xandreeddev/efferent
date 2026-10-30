import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule } from "../idiomGate.js"
import { matchesIn } from "./syntax.js"

/** The effect types whose third parameter is what they require: `R` of
 *  `Effect<A, E, R>` and `Stream<A, E, R>`, `RIn` of `Layer<ROut, E, RIn>`. */
const REQUIRING = ["Effect", "Stream", "Layer"]

/** `Name` or `Namespace.Name`: the identifier that names the type. */
const nameOf = (typeName: ts.EntityName): ts.Identifier => (ts.isQualifiedName(typeName) ? typeName.right : typeName)

/** Whether `name` resolves to an interface the `effect` package declares,
 *  so a type of one's own that happens to be called `Layer` passes. */
const isEffectInterface = (checker: ts.TypeChecker, name: ts.Identifier): boolean => {
  const symbol = checker.getSymbolAtLocation(name)
  const resolved = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  return (resolved?.declarations ?? []).some((declaration) =>
    ts.isInterfaceDeclaration(declaration) && /[\\/]node_modules[\\/]effect[\\/]/.test(declaration.getSourceFile().fileName))
}

/** `unknown` as what an effect requires turns the requirement check off:
 *  `Effect<A, E, unknown>` takes any `Effect<A, E, R>`, so a service it
 *  reads compiles whether anything provides it or not, and the miss
 *  surfaces mid-run as a defect. Type-aware: an alias of `unknown` counts,
 *  a local type named like an effect one does not. */
export const noUnknownRequirements: IdiomRule = {
  id: RuleId.make("effect/no-unknown-requirements"),
  defaultSeverity: "error",
  description: "an `Effect`, `Stream` or `Layer` type names what it requires: never `unknown` as its R",
  fixHint:
    "name the services in R (their identifiers, `never` for none) or keep R a type parameter; where a JSON config picks the services at run time, declare their keys and check them by key where they are provided",
  check: ({ sourceFile, checker }) =>
    matchesIn(sourceFile, (node) => {
      if (!ts.isTypeReferenceNode(node)) return []
      const name = nameOf(node.typeName)
      const requirements = node.typeArguments?.[2]
      return REQUIRING.includes(name.text) &&
        requirements !== undefined &&
        (checker.getTypeFromTypeNode(requirements).flags & ts.TypeFlags.Unknown) !== 0 &&
        isEffectInterface(checker, name)
        ? [{ node, message: `\`${node.typeName.getText(sourceFile)}<…, unknown>\` hides what it requires: a service it reads compiles whether anything provides it or not` }]
        : []
    }),
}
