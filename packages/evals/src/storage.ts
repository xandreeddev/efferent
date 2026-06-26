import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { RunAgg } from "./trace/process.js"

/**
 * Reproducibility manifest — what the run was pinned to, so a saved baseline is
 * reconstructable and comparable (the SWE-bench/LiveCodeBench lesson: pin the
 * image by digest + lock the deps + the source commit + the models).
 */
export interface RunManifest {
  /** Content-addressed sandbox image (`oven/bun@sha256:…`). */
  readonly imageDigest?: string
  /** Short sha256 of `bun.lock` — the exact dependency closure. */
  readonly bunLockHash?: string
  /** Model selection per role for each config (configName → {main,code,fast,judge}). */
  readonly models?: Record<string, Record<string, string>>
}

/** Short sha256 of a file's contents, or undefined if unreadable. */
export const fileHash = (path: string): string | undefined => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16)
  } catch {
    return undefined
  }
}

/**
 * Persisted eval result — a dated, git-stamped snapshot of a run's per-config /
 * per-suite / per-case aggregates. Committed as a BASELINE so a later run can be
 * compared against it (`--compare`) to answer "did this change help?". Plain
 * JSON (the `RunAgg[]` the report is built from + metadata) — no schema churn.
 */
export interface SavedReport {
  readonly version: 1
  /** ISO timestamp of the run (passed in — `run.ts` is a driver, Date is fine). */
  readonly ts: string
  /** Short git SHA the run was taken at, when in a repo. */
  readonly gitSha?: string
  /** A human note (e.g. "baseline before the routing change"). */
  readonly label?: string
  /** What the run was pinned to (image digest, dep-lock hash, models). */
  readonly manifest?: RunManifest
  readonly runs: ReadonlyArray<RunAgg>
}

/** Short HEAD sha, or undefined outside a repo. Fail-soft (never throws). */
export const gitSha = (): string | undefined => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
}

export const buildReport = (
  runs: ReadonlyArray<RunAgg>,
  ts: string,
  sha?: string,
  label?: string,
  manifest?: RunManifest,
): SavedReport => ({
  version: 1,
  ts,
  ...(sha !== undefined ? { gitSha: sha } : {}),
  ...(label !== undefined ? { label } : {}),
  ...(manifest !== undefined ? { manifest } : {}),
  runs,
})

/** Write a report to `path` (creating parent dirs). Pretty JSON so a committed
 *  baseline diffs readably in review. */
export const writeReport = (path: string, report: SavedReport): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

export const readReport = (path: string): SavedReport =>
  JSON.parse(readFileSync(path, "utf8")) as SavedReport

export const reportExists = (path: string): boolean => existsSync(path)
