import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule } from "../idiomGate.js"
import { matchesIn } from "./syntax.js"

/** The keys effect/ai's providers file their metadata and options under,
 *  and the one a model router kept its own fields under. */
const PROVIDER_NAMESPACES: ReadonlyArray<string> = ["anthropic", "openai", "google", "router"]

/** A key written as a name, a string or a computed string: `anthropic`, `"anthropic"`, `["anthropic"]`. */
const keyText = (name: ts.Node): ReadonlyArray<string> =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? [name.text]
    : ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
      ? [name.expression.text]
      : []

/** The key a node names: an object literal's or a type's property, a destructured property, a property read. */
const keysOf = (node: ts.Node): ReadonlyArray<string> => {
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isPropertySignature(node)) {
    return keyText(node.name)
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) return keyText(node.propertyName ?? node.name)
  if (ts.isPropertyAccessExpression(node)) return keyText(node.name)
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return [node.argumentExpression.text]
  return []
}

/** Provider-neutral code carries a provider's metadata and options as an
 *  opaque blob: naming one provider's namespace couples it to that
 *  provider's private fields, which belong in that provider's adapter.
 *  Its own fields go under its own key. */
export const noProviderNamespace: IdiomRule = {
  id: RuleId.make("effect/no-provider-namespace"),
  defaultSeverity: "error",
  description: "provider-neutral code never names a provider's namespace (`anthropic`, `openai`, `google`, `router`)",
  fixHint:
    "carry provider metadata and options opaque (effect/ai's `ProviderMetadata` and `ProviderOptions`), keep code for one provider in that provider's adapter, and put your own fields under your own key",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      keysOf(node)
        .filter((key) => PROVIDER_NAMESPACES.includes(key))
        .map((key) => ({ node, message: `\`${key}\` names a provider's namespace` })),
    ),
}
