import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

const fileName = (sourceFile: ts.SourceFile): string => sourceFile.fileName.replaceAll("\\", "/")

const isCore = (sourceFile: ts.SourceFile): boolean =>
  /\.(?:entity|entity\.functions|usecase|usecase\.functions)\.ts$/.test(fileName(sourceFile))

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)

const isExported = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword)

export const noRawPromiseCore: IdiomRule = {
  id: RuleId.make("architecture/no-raw-promise-core"),
  defaultSeverity: "error",
  description: "entity and use-case code is Effect-native; Promise orchestration belongs at adapters",
  fixHint:
    "return and compose Effect values; expose Effect-returning ports and wrap foreign promises in an adapter with Effect.tryPromise",
  check: ({ sourceFile }) => {
    if (!isCore(sourceFile)) return []
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isAwaitExpression(node)) matches.push({ node, message: "await is an adapter concern" })
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node)) &&
        hasModifier(node, ts.SyntaxKind.AsyncKeyword)
      ) {
        matches.push({ node, message: "async functions are banned in the Effect core" })
      }
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        node.typeName.text === "Promise"
      ) {
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
        if (method === "then" || method === "catch") {
          matches.push({ node, message: `.${method}() is banned in the Effect core` })
        }
        if (
          ts.isIdentifier(owner) &&
          owner.text === "Effect" &&
          (method.startsWith("runPromise") || method.startsWith("runSync"))
        ) {
          matches.push({ node, message: `Effect.${method} belongs at a runtime edge` })
        }
      }
    })
    return matches
  },
}

export const noRuntimeImportsCore: IdiomRule = {
  id: RuleId.make("architecture/no-runtime-imports-core"),
  defaultSeverity: "error",
  description: "the inner core does not import runtimes, providers, UI frameworks, or concrete SDKs",
  fixHint: "move the integration behind a Context.Tag port and implement it in a .adapter.ts file",
  check: ({ sourceFile }) => {
    if (!isCore(sourceFile)) return []
    const banned = ["node:", "bun", "@xandreed/providers", "playwright", "@opentui/", "solid-js"]
    return sourceFile.statements.flatMap((statement): ReadonlyArray<RuleMatch> => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
      const specifier = statement.moduleSpecifier.text
      return banned.some((prefix) => specifier === prefix || specifier.startsWith(prefix))
        ? [{ node: statement, message: `runtime import "${specifier}" in the inner core` }]
        : []
    })
  },
}

export const contractsContainNoBehavior: IdiomRule = {
  id: RuleId.make("architecture/contracts-contain-no-behavior"),
  defaultSeverity: "error",
  description: ".entity.ts and .usecase.ts files contain schemas and derived types, not behavior",
  fixHint: "move exported behavior to the adjacent qualified .functions.ts file",
  check: ({ sourceFile }) => {
    if (!/\.(?:entity|usecase)\.ts$/.test(fileName(sourceFile))) return []
    return sourceFile.statements.flatMap((statement): ReadonlyArray<RuleMatch> => {
      if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
        return [{ node: statement, message: "exported behavior in a schema contract file" }]
      }
      if (ts.isVariableStatement(statement) && isExported(statement)) {
        return statement.declarationList.declarations.flatMap((declaration) =>
          declaration.initializer !== undefined &&
          (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
            ? [{ node: declaration, message: "exported behavior in a schema contract file" }]
            : [],
        )
      }
      return []
    })
  },
}

export const contextTagsLiveInPorts: IdiomRule = {
  id: RuleId.make("architecture/context-tags-live-in-ports"),
  defaultSeverity: "error",
  description: "Context.Tag service contracts live in .port.ts files",
  fixHint: "move the service contract to a .port.ts file; keep implementations in adapters",
  check: ({ sourceFile }) => {
    if (/\.port\.ts$/.test(fileName(sourceFile)) || fileName(sourceFile).includes("/ports/")) return []
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Context" &&
        (node.name.text === "Tag" || node.name.text === "GenericTag")
      ) {
        matches.push({ node, message: `Context.${node.name.text} declared outside a .port.ts file` })
      }
    })
    return matches
  },
}

export const layersLiveAtEdges: IdiomRule = {
  id: RuleId.make("architecture/layers-live-at-edges"),
  defaultSeverity: "error",
  description: "concrete Layers are constructed only by adapters, composition roots, and tests",
  fixHint: "export the concrete Layer from a .adapter.ts file and compose it in main.ts",
  check: ({ sourceFile }) => {
    if (!isCore(sourceFile)) return []
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Layer"
      ) {
        matches.push({ node, message: `Layer.${node.name.text} constructed inside the Effect core` })
      }
    })
    return matches
  },
}

export const effectArchitectureRules: ReadonlyArray<IdiomRule> = [
  noRawPromiseCore,
  noRuntimeImportsCore,
  contractsContainNoBehavior,
  contextTagsLiveInPorts,
  layersLiveAtEdges,
]
