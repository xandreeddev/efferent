import { Effect, Option } from "effect"
import * as path from "node:path"
import * as ts from "typescript"
import { GateName, RuleId } from "../domain/Brands.js"
import { GateCrash } from "../domain/Errors.js"
import { Finding } from "../domain/Finding.js"
import type { LayerConfig, LayerSpec } from "../domain/Rules.js"
import type { Gate, Workspace } from "../ports/Gate.js"
import { locationOf, matchesGlob, projectSourceFiles, toWorkspacePath } from "./astWalk.js"
import { TsProject } from "./TsProject.js"

export const BOUNDARIES_GATE = GateName.make("boundaries")

const ILLEGAL_IMPORT = RuleId.make("boundaries/illegal-import")
const ILLEGAL_EXTERNAL = RuleId.make("boundaries/illegal-external")

const layerOf = (layers: LayerConfig, relPath: string): Option.Option<LayerSpec> =>
  Option.fromNullable(layers.layers.find((l) => matchesGlob(l.path, relPath)))

/** `./x.js` (the ESM authoring convention) resolves to `./x.ts` on disk. */
const toSourceRelative = (importerRel: string, specifier: string): string => {
  const joined = path.posix.join(path.posix.dirname(importerRel), specifier)
  return joined.endsWith(".ts") ? joined : joined.replace(/\.js$/, ".ts")
}

/** A prefix ending in `/` or `:` is a raw prefix (`@effect/` → `@effect/ai`,
 *  `node:` → `node:path`); otherwise it matches the exact package or its
 *  subpaths (`effect` → `effect`, `effect/Function` — never `effect-foo`). */
const externalAllowed = (layer: LayerSpec, specifier: string): boolean =>
  layer.externals.some(
    (prefix) =>
      specifier === prefix ||
      specifier.startsWith(
        prefix.endsWith("/") || prefix.endsWith(":") ? prefix : `${prefix}/`,
      ),
  )

/** Every import (and re-export) clause of a source file, with its node. */
const moduleSpecifiers = (
  sourceFile: ts.SourceFile,
): ReadonlyArray<{ readonly node: ts.Node; readonly specifier: string }> =>
  sourceFile.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [{ node: statement, specifier: statement.moduleSpecifier.text }]
      : [],
  )

const checkSpecifier = (params: {
  readonly layers: LayerConfig
  readonly layer: LayerSpec
  readonly importerRel: string
  readonly specifier: string
  readonly sourceFile: ts.SourceFile
  readonly node: ts.Node
  readonly rootDir: string
}): ReadonlyArray<Finding> => {
  const { layers, layer, importerRel, specifier, sourceFile, node, rootDir } = params
  if (specifier.startsWith(".")) {
    const targetRel = toSourceRelative(importerRel, specifier)
    return Option.match(layerOf(layers, targetRel), {
      // A file outside every declared layer is unconstrained.
      onNone: () => [],
      onSome: (target) =>
        target.name === layer.name || layer.canImport.includes(target.name)
          ? []
          : [
              new Finding({
                rule: ILLEGAL_IMPORT,
                severity: "error",
                message: `layer "${layer.name}" must not import layer "${target.name}" (${specifier})`,
                location: Option.some(locationOf(sourceFile, node, rootDir)),
                fixHint: Option.some(
                  `allowed from "${layer.name}": ${[layer.name, ...layer.canImport].join(", ")} — invert the dependency or move the code`,
                ),
              }),
            ],
    })
  }
  return externalAllowed(layer, specifier)
    ? []
    : [
        new Finding({
          rule: ILLEGAL_EXTERNAL,
          severity: "error",
          message: `layer "${layer.name}" must not depend on external "${specifier}"`,
          location: Option.some(locationOf(sourceFile, node, rootDir)),
          fixHint: Option.some(
            `externals allowed in "${layer.name}": ${layer.externals.join(", ")} — declare a port instead`,
          ),
        }),
      ]
}

/**
 * Dependency direction as a GATE, not a convention: each layer declares what
 * it may import (internal layers by name, externals by prefix); everything
 * else is a finding. Pointing the layer globs at package dirs generalizes
 * this to the monorepo's `cli → adapters → core` rule.
 */
export const makeBoundariesGate = (
  layers: LayerConfig,
  tsconfigRel: string,
): Gate<TsProject> => ({
  name: BOUNDARIES_GATE,
  kind: "static",
  deterministic: true,
  run: (workspace: Workspace) =>
    Effect.gen(function* () {
      const tsp = yield* TsProject
      const project = yield* tsp
        .load(path.resolve(workspace.rootDir, tsconfigRel))
        .pipe(
          Effect.mapError(
            (e) => new GateCrash({ gate: BOUNDARIES_GATE, message: e.message }),
          ),
        )
      return projectSourceFiles(project, workspace.rootDir).flatMap((sourceFile) => {
        const importerRel = toWorkspacePath(workspace.rootDir, sourceFile.fileName)
        return Option.match(layerOf(layers, importerRel), {
          onNone: () => [] as ReadonlyArray<Finding>,
          onSome: (layer) =>
            moduleSpecifiers(sourceFile).flatMap(({ node, specifier }) =>
              checkSpecifier({
                layers,
                layer,
                importerRel,
                specifier,
                sourceFile,
                node,
                rootDir: workspace.rootDir,
              }),
            ),
        })
      })
    }),
})
