/**
 * What a built package's declarations may import: its own files, the packages its manifest
 * declares (`dependencies` and `peerDependencies`) and the runtime's own modules (`node:*` and
 * Node's built-in names, `bun`, `bun:*`). A declaration naming any other package, such as one the
 * compiler reached through another workspace package, leaves a consumer of the package alone with
 * a type that does not resolve. verify-packages.ts fails on each (`declarationImportProblems`);
 * declaration-imports.test.ts covers it.
 */
import { builtinModules } from "node:module"
import ts from "typescript"

/** The fields of a built manifest the check reads. */
export interface DeclaringManifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

/** One emitted declaration file: its path as a message shows it, and its text. */
export interface Declaration {
  readonly path: string
  readonly text: string
}

/**
 * Every module a declaration file names: its import and export clauses, `import("…")` types,
 * `import x = require("…")`, the modules it augments and its `/// <reference types>`.
 */
export const declarationSpecifiers = (text: string): ReadonlyArray<string> => {
  const source = ts.createSourceFile("declaration.d.ts", text, ts.ScriptTarget.Latest, true)
  const named = (node: ts.Node): ReadonlyArray<string> => {
    const own =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) ? [node.moduleSpecifier.text]
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) ? [node.argument.literal.text]
      : ts.isExternalModuleReference(node) && ts.isStringLiteral(node.expression) ? [node.expression.text]
      : ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) ? [node.name.text]
      : []
    return [...own, ...node.getChildren(source).flatMap(named)]
  }
  return [...source.typeReferenceDirectives.map((reference) => reference.fileName), ...named(source)]
}

/** `@scope/name/sub` names the package `@scope/name`, `name/sub` the package `name`. */
const packageOf = (specifier: string): string =>
  specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

const builtins: ReadonlySet<string> = new Set([...builtinModules, "bun", "node"])

/** Whether a declaration of `manifest`'s package may name `specifier`. */
const declared = (manifest: DeclaringManifest, specifier: string): boolean => {
  if (specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("bun:")) return true
  const name = packageOf(specifier)
  return name === manifest.name || builtins.has(name) || name in (manifest.dependencies ?? {}) || name in (manifest.peerDependencies ?? {})
}

/** Each import of `declarations` that `manifest` does not declare, naming the file and the module. */
export const declarationImportProblems = (manifest: DeclaringManifest, declarations: ReadonlyArray<Declaration>): ReadonlyArray<string> =>
  declarations.flatMap((declaration) =>
    Array.from(new Set(declarationSpecifiers(declaration.text)))
      .filter((specifier) => !declared(manifest, specifier))
      .map((specifier) => `${declaration.path} imports "${specifier}", which ${manifest.name} does not declare as a dependency or a peer`))
