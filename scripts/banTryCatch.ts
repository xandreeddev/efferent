#!/usr/bin/env bun
/**
 * Ban try/catch, throw, and .catch() from @efferent/core/src/.
 *
 * Effect's typed errors mean all error handling goes through
 * Effect.catchAll/Effect.catchTag, and errors are created with
 * Effect.fail/Effect.die — never thrown.
 *
 * Uses the TypeScript compiler API (zero new deps).
 */

import * as ts from "typescript"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dir, "..", "packages", "sdk-core", "src")

function collectTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full))
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(full)
    }
  }
  return files
}

function checkFile(filePath: string): string[] {
  const source = readFileSync(filePath, "utf-8")
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
  const violations: string[] = []

  function visit(node: ts.Node) {
    // try {} catch {} — banned: use Effect.catchAll / Effect.catchTag
    if (ts.isTryStatement(node)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      violations.push(
        `${relative(ROOT, filePath)}:${line + 1}:${character + 1}  try/catch is banned` +
          ` — use Effect.catchAll / Effect.catchTag`
      )
    }

    // throw — banned: use Effect.fail / Effect.die
    if (ts.isThrowStatement(node)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      violations.push(
        `${relative(ROOT, filePath)}:${line + 1}:${character + 1}  throw is banned` +
          ` — use Effect.fail / Effect.die`
      )
    }

    // .catch() — banned: use Effect.catchAll / Effect.catchTag
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      violations.push(
        `${relative(ROOT, filePath)}:${line + 1}:${character + 1}  .catch() is banned` +
          ` — use Effect.catchAll / Effect.catchTag`
      )
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)
  return violations
}

const files = collectTsFiles(ROOT)
const allViolations: string[] = []

for (const file of files) {
  // Skip generated files
  if (file.includes(".generated.")) continue
  allViolations.push(...checkFile(file))
}

if (allViolations.length > 0) {
  console.error(`\n❌ Banned constructs found in @efferent/sdk-core/src/:\n`)
  for (const v of allViolations) console.error(`  ${v}`)
  console.error(
    `\nUse Effect.fail / Effect.die to create errors and` +
      ` Effect.catchAll / Effect.catchTag to handle them.\n`
  )
  process.exit(1)
}

console.error("✅ No try/catch, throw, or .catch() in @efferent/sdk-core/src/")
