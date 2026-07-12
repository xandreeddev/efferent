/** Project-owned Effect ports-and-adapters rules vendored by `smith profile`. */
import * as ts from "typescript"

interface Context {
  readonly sourceFile: ts.SourceFile
  readonly checker: ts.TypeChecker
}

interface Match {
  readonly node: ts.Node
  readonly message: string
}

const walk = (root: ts.Node, visit: (node: ts.Node) => void): void => {
  visit(root)
  ts.forEachChild(root, (child) => walk(child, visit))
}

const nameOf = (sourceFile: ts.SourceFile): string => sourceFile.fileName.replaceAll("\\", "/")
const isCore = (sourceFile: ts.SourceFile): boolean =>
  /\.(?:entity|entity\.functions|usecase|usecase\.functions)\.ts$/.test(nameOf(sourceFile))
const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
const isExported = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword)

const noRawPromiseCore = {
  id: "architecture/no-raw-promise-core",
  defaultSeverity: "error",
  description: "entity and use-case code is Effect-native",
  fixHint: "compose Effect values and wrap foreign promises in an adapter with Effect.tryPromise",
  check: ({ sourceFile }: Context): ReadonlyArray<Match> => {
    if (!isCore(sourceFile)) return []
    const matches: Array<Match> = []
    walk(sourceFile, (node) => {
      if (ts.isAwaitExpression(node)) matches.push({ node, message: "await is an adapter concern" })
      if (
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) &&
        hasModifier(node, ts.SyntaxKind.AsyncKeyword)
      ) matches.push({ node, message: "async functions are banned in the Effect core" })
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "Promise") {
        matches.push({ node, message: "Promise types are banned in the Effect core" })
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise") {
        matches.push({ node, message: "new Promise is banned in the Effect core" })
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const owner = node.expression.expression
        const method = node.expression.name.text
        if (ts.isIdentifier(owner) && owner.text === "Promise") {
          matches.push({ node, message: `Promise.${method} is banned; use Effect concurrency` })
        }
        if (method === "then" || method === "catch") matches.push({ node, message: `.${method}() is banned in the Effect core` })
        if (ts.isIdentifier(owner) && owner.text === "Effect" && (method.startsWith("runPromise") || method.startsWith("runSync"))) {
          matches.push({ node, message: `Effect.${method} belongs at a runtime edge` })
        }
      }
    })
    return matches
  },
}

const noRuntimeImportsCore = {
  id: "architecture/no-runtime-imports-core",
  defaultSeverity: "error",
  description: "the inner core imports no runtimes, providers, UI frameworks, or concrete SDKs",
  fixHint: "move the integration behind a Context.Tag port and implement it in a .adapter.ts file",
  check: ({ sourceFile }: Context): ReadonlyArray<Match> => {
    if (!isCore(sourceFile)) return []
    const banned = ["node:", "bun", "@xandreed/providers", "playwright", "@opentui/", "solid-js"]
    return sourceFile.statements.flatMap((statement): ReadonlyArray<Match> => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
      const specifier = statement.moduleSpecifier.text
      return banned.some((prefix) => specifier === prefix || specifier.startsWith(prefix))
        ? [{ node: statement, message: `runtime import "${specifier}" in the inner core` }]
        : []
    })
  },
}

const contractsContainNoBehavior = {
  id: "architecture/contracts-contain-no-behavior",
  defaultSeverity: "error",
  description: ".entity.ts and .usecase.ts files contain schemas and derived types, not behavior",
  fixHint: "move exported behavior to the adjacent qualified .functions.ts file",
  check: ({ sourceFile }: Context): ReadonlyArray<Match> => {
    if (!/\.(?:entity|usecase)\.ts$/.test(nameOf(sourceFile))) return []
    return sourceFile.statements.flatMap((statement): ReadonlyArray<Match> => {
      if (ts.isFunctionDeclaration(statement) && isExported(statement)) return [{ node: statement, message: "exported behavior in a schema contract file" }]
      if (ts.isVariableStatement(statement) && isExported(statement)) {
        return statement.declarationList.declarations.flatMap((declaration) =>
          declaration.initializer !== undefined && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
            ? [{ node: declaration, message: "exported behavior in a schema contract file" }]
            : [],
        )
      }
      return []
    })
  },
}

const contextTagsLiveInPorts = {
  id: "architecture/context-tags-live-in-ports",
  defaultSeverity: "error",
  description: "Context.Tag service contracts live in .port.ts files",
  fixHint: "move the service contract to a .port.ts file and keep implementations in adapters",
  check: ({ sourceFile }: Context): ReadonlyArray<Match> => {
    if (/\.port\.ts$/.test(nameOf(sourceFile)) || nameOf(sourceFile).includes("/ports/")) return []
    const matches: Array<Match> = []
    walk(sourceFile, (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Context" && (node.name.text === "Tag" || node.name.text === "GenericTag")) {
        matches.push({ node, message: `Context.${node.name.text} declared outside a .port.ts file` })
      }
    })
    return matches
  },
}

const layersLiveAtEdges = {
  id: "architecture/layers-live-at-edges",
  defaultSeverity: "error",
  description: "concrete Layers are constructed only by adapters, composition roots, and tests",
  fixHint: "export the concrete Layer from a .adapter.ts file and compose it in main.ts",
  check: ({ sourceFile }: Context): ReadonlyArray<Match> => {
    if (!isCore(sourceFile)) return []
    const matches: Array<Match> = []
    walk(sourceFile, (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Layer") {
        matches.push({ node, message: `Layer.${node.name.text} constructed inside the Effect core` })
      }
    })
    return matches
  },
}

export const rules = [
  noRawPromiseCore,
  noRuntimeImportsCore,
  contractsContainNoBehavior,
  contextTagsLiveInPorts,
  layersLiveAtEdges,
]
