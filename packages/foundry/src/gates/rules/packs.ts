import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { ConfigError } from "../../domain/Errors.js"
import type { IdiomRule } from "../idiomGate.js"
import { brandedIdFields } from "./brandedIdFields.js"
import { matchOverTagSwitch } from "./matchOverTagSwitch.js"
import { noAsAny } from "./noAsAny.js"
import { noEmptyCatch } from "./noEmptyCatch.js"
import { noLet } from "./noLet.js"
import { noLoopStatements } from "./noLoopStatements.js"
import { noNullableReturn } from "./noNullableReturn.js"
import { noParallelInterface } from "./noParallelInterface.js"
import { noSkippedTests } from "./noSkippedTests.js"
import { noTryCatch } from "./noTryCatch.js"
import { effectArchitectureRules } from "./effectArchitecture.js"

/**
 * Packs are a LIBRARY, not builtins: the platform ships engines, never
 * opinions. `gatesFromConfig` resolves rules ONLY against what the config
 * module itself provides (`rulePacks` / `customRules` named exports) — a
 * workspace that wants the effect house style says so explicitly, and
 * efferent's own configs are just another consumer of the same mechanism.
 */
export interface RulePack {
  readonly name: string
  readonly rules: ReadonlyArray<IdiomRule>
}

/** The Effect.ts house style — errors are values, state is a fold. */
export const effectPack: RulePack = {
  name: "effect",
  rules: [
    noTryCatch,
    noLet,
    noLoopStatements,
    noNullableReturn,
    matchOverTagSwitch,
    noAsAny,
    brandedIdFields,
    noParallelInterface,
  ],
}

/** Paradigm-neutral factory-integrity rules — each defends the harness's
 *  own threat model (gaming the gates), not a style opinion. */
export const qualityPack: RulePack = {
  name: "quality",
  rules: [noSkippedTests, noEmptyCatch],
}

/** Ports-and-adapters file roles for an Effect-native inner core. */
export const effectArchitecturePack: RulePack = {
  name: "effect-architecture",
  rules: effectArchitectureRules,
}

export const builtinPacks: ReadonlyArray<RulePack> = [effectPack, qualityPack, effectArchitecturePack]

/** The full shipped library — for in-monorepo consumers and tests. Config
 *  resolution NEVER falls back to this implicitly. */
export const allBuiltinRules: ReadonlyArray<IdiomRule> = builtinPacks.flatMap(
  (pack) => pack.rules,
)

/** `packages/foundry/vendor/<pack>/` — the packs re-authored as PLAIN
 *  structural rule modules (string ids, no foundry imports, only the
 *  workspace's own `typescript`). External workspaces cannot import foundry
 *  (private, source-run), so the profile session WRITES these files into the
 *  project (`.efferent/gates/`) — project-owned, human-editable. A golden
 *  test pins vendored ≡ library findings, so drift fails CI. */
const VENDOR_DIR = path.resolve(import.meta.dir, "../../../vendor")

export const vendoredPackFiles = (
  packName: string,
): Effect.Effect<ReadonlyArray<{ readonly path: string; readonly content: string }>, ConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const dir = path.join(VENDOR_DIR, packName)
      const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".ts")).sort()
      return Promise.all(
        names.map(async (name) => ({
          path: `${packName}/${name}`,
          content: await fs.readFile(path.join(dir, name), "utf8"),
        })),
      )
    },
    catch: () =>
      new ConfigError({
        path: path.join(VENDOR_DIR, packName),
        message: `no vendorable pack named "${packName}" — known: ${builtinPacks.map((p) => p.name).join(", ")}`,
      }),
  })
