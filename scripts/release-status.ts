#!/usr/bin/env bun
/** Audit public npm release metadata without credentials, publication or git changes. */
import { appendFile, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Result, Schema } from "effect"
import { isReleaseVersion, readSourceManifest, releaseDirectories, releaseNames, sharedReleaseVersion } from "./release-version-plan.js"

export const auditedReleaseNames: ReadonlyArray<string> = [...releaseNames, "efferent"]
const registry = "https://registry.npmjs.org"
const shaPattern = /^[a-f0-9]{40}$/
// A 64-byte SHA-512 digest has 86 base64 characters, canonical pad bits and two padding characters.
const validIntegrity = (value: string | undefined): boolean => value !== undefined && /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/.test(value)
const RegistryVersion = Schema.Struct({
  name: Schema.String, version: Schema.String, gitHead: Schema.optionalKey(Schema.String),
  dist: Schema.optionalKey(Schema.Struct({
    integrity: Schema.optionalKey(Schema.String),
    attestations: Schema.optionalKey(Schema.Struct({
      url: Schema.String,
      provenance: Schema.optionalKey(Schema.Struct({ predicateType: Schema.String })),
    })),
  })),
})
const Packument = Schema.Struct({ versions: Schema.Record(Schema.String, Schema.JsonObject) })
export interface ReleaseAuditOptions { readonly version: string; readonly sha: string; readonly waitSeconds?: number; readonly requireProvenance?: boolean }
export interface ReleaseAuditDependencies {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  readonly now: () => number
  readonly sleep: (milliseconds: number) => Promise<void>
}
export interface ReleaseAuditEntry {
  readonly name: string
  readonly status: "published" | "missing" | "mismatch" | "unavailable"
  readonly version: string | null
  readonly gitHead: string | null
  readonly integrity: string | null
  /** Presence of registry provenance metadata; this does not verify its signature. */
  readonly provenance: boolean
  readonly via: "version" | "packument"
  readonly reason: string | null
  readonly retryable: boolean
}
export interface ReleaseAuditReport {
  readonly ok: boolean; readonly version: string; readonly sha: string; readonly requireProvenance: boolean
  readonly attempts: number; readonly entries: ReadonlyArray<ReleaseAuditEntry>
  readonly counts: { readonly published: number; readonly missing: number; readonly mismatch: number; readonly unavailable: number; readonly provenance: number }
}
const boundedMap = async <A, B>(items: ReadonlyArray<A>, work: (item: A) => Promise<B>): Promise<ReadonlyArray<B>> => items.length === 0
  ? [] : [...await Promise.all(items.slice(0, 6).map(work)), ...await boundedMap(items.slice(6), work)]
const absent = (name: string, status: "missing" | "unavailable", via: ReleaseAuditEntry["via"], reason: string): ReleaseAuditEntry => ({
  name, status, via, version: null, gitHead: null, integrity: null, provenance: false, reason, retryable: true,
})

/** Injected transport and clock keep propagation/retry tests deterministic and key-free. */
export const auditRelease = async (options: ReleaseAuditOptions, dependencies: ReleaseAuditDependencies = {
  fetch: (url, init) => fetch(url, init), now: () => Date.now(), sleep: (milliseconds) => Bun.sleep(milliseconds),
}): Promise<ReleaseAuditReport> => {
  const wait = options.waitSeconds ?? 0
  if (!isReleaseVersion(options.version) || !shaPattern.test(options.sha) || !Number.isInteger(wait) || wait < 0 || wait > 300) throw new Error("Expected a stable release version, a full lowercase SHA, and --wait between 0 and 300 seconds")
  const start = dependencies.now()
  const deadline = start + wait * 1000
  const read = async (url: string): Promise<Result.Result<{ readonly status: number; readonly body: string }, string>> => {
    const remaining = wait === 0 ? 10_000 : Math.min(10_000, Math.max(1, deadline - dependencies.now()))
    try {
      const response = await dependencies.fetch(`${url}?audit=${dependencies.now()}`, {
        method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(remaining),
      })
      return Result.succeed({ status: response.status, body: response.status === 200 ? await response.text() : "" })
    } catch {
      return Result.fail("The public npm registry request failed or timed out")
    }
  }
  const inspect = (name: string, value: Result.Result<typeof RegistryVersion.Type, Schema.SchemaError>, via: ReleaseAuditEntry["via"]): ReleaseAuditEntry => {
    if (Result.isFailure(value)) return absent(name, "unavailable", via, "Registry metadata did not match the expected schema")
    const item = value.success
    const provenance = (item.dist?.attestations?.url.startsWith("https://") ?? false) && (item.dist?.attestations?.provenance?.predicateType.length ?? 0) > 0
    const mismatches = [
      ...(item.name === name ? [] : ["Package name differs from the request"]),
      ...(item.version === options.version ? [] : ["Published version differs from the request"]),
      ...(item.gitHead === options.sha ? [] : ["Published gitHead differs from the expected source commit"]),
      ...(validIntegrity(item.dist?.integrity) ? [] : ["Published sha512 integrity is missing or invalid"]),
    ]
    const needsProvenance = options.requireProvenance === true && !provenance
    return { name, via, version: item.version, gitHead: item.gitHead ?? null, integrity: item.dist?.integrity ?? null, provenance,
      status: mismatches.length > 0 || needsProvenance ? "mismatch" : "published",
      reason: mismatches.length > 0 ? mismatches.join("; ") : needsProvenance ? "Registry provenance metadata is missing" : null,
      retryable: mismatches.length === 0 && needsProvenance,
    }
  }
  const probe = async (name: string): Promise<ReleaseAuditEntry> => {
    if (wait > 0 && dependencies.now() >= deadline) return absent(name, "unavailable", "version", "The registry audit deadline elapsed")
    const base = `${registry}/${name.replace("/", "%2f")}`
    const version = await read(`${base}/${options.version}`)
    if (Result.isFailure(version)) return absent(name, "unavailable", "version", version.failure)
    if (version.success.status === 200) return inspect(name, Schema.decodeUnknownResult(Schema.fromJsonString(RegistryVersion))(version.success.body), "version")
    if (version.success.status !== 404) return absent(name, "unavailable", "version", `The version endpoint returned HTTP ${version.success.status}`)
    const full = await read(base)
    if (Result.isFailure(full)) return absent(name, "unavailable", "packument", full.failure)
    if (full.success.status === 404) return absent(name, "missing", "packument", "The package version is not available")
    if (full.success.status !== 200) return absent(name, "unavailable", "packument", `The package endpoint returned HTTP ${full.success.status}`)
    const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Packument))(full.success.body)
    if (Result.isFailure(decoded)) return absent(name, "unavailable", "packument", "The package metadata did not match the expected schema")
    const item = decoded.success.versions[options.version]
    return item === undefined ? absent(name, "missing", "packument", "The package metadata does not contain the release version")
      : inspect(name, Schema.decodeUnknownResult(RegistryVersion)(item), "packument")
  }
  const report = (entries: ReadonlyArray<ReleaseAuditEntry>, attempts: number): ReleaseAuditReport => ({
    ok: entries.every((entry) => entry.status === "published"), version: options.version, sha: options.sha, requireProvenance: options.requireProvenance ?? false, attempts, entries,
    counts: { published: entries.filter((entry) => entry.status === "published").length, missing: entries.filter((entry) => entry.status === "missing").length,
      mismatch: entries.filter((entry) => entry.status === "mismatch").length, unavailable: entries.filter((entry) => entry.status === "unavailable").length,
      provenance: entries.filter((entry) => entry.provenance).length },
  })
  const poll = async (previous: ReadonlyArray<ReleaseAuditEntry>, attempts: number): Promise<ReleaseAuditReport> => {
    const pending = previous.length === 0 ? auditedReleaseNames : previous.filter((entry) => entry.retryable).map((entry) => entry.name)
    const updates = await boundedMap(pending, probe)
    const entries = auditedReleaseNames.map((name) => updates.find((entry) => entry.name === name) ?? previous.find((entry) => entry.name === name)!)
    const current = report(entries, attempts)
    if (current.ok || wait === 0 || entries.some((entry) => entry.status === "mismatch" && !entry.retryable) || dependencies.now() >= deadline) return current
    await dependencies.sleep(Math.min(5000, Math.max(0, deadline - dependencies.now())))
    return dependencies.now() >= deadline ? current : poll(entries, attempts + 1)
  }
  return poll([], 1)
}

/** Inference checks the whole source distribution group, not one potentially divergent manifest. */
export const releaseAuditSource = async (root: string): Promise<{ readonly version: string; readonly sha: string }> => {
  const manifests = await boundedMap(releaseDirectories, async (directory) => {
    const read = readSourceManifest(await readFile(resolve(root, "packages", directory, "package.json"), "utf8"))
    if (Result.isFailure(read)) throw new Error(`The source manifest for ${directory} is invalid`)
    if (read.success.name !== `@xandreed/${directory}`) throw new Error(`The source manifest for ${directory} has another package name`)
    return read.success
  })
  const version = sharedReleaseVersion(manifests)
  if (Result.isFailure(version)) throw new Error(version.failure)
  const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD^{commit}"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const sha = head.stdout.toString().trim()
  if (!head.success || !shaPattern.test(sha)) throw new Error("The source checkout must have a readable full commit SHA")
  return { version: version.success, sha }
}

const summaryOf = (report: ReleaseAuditReport): string => {
  const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("`", "'").replaceAll("\n", " ")
  return [`## npm release audit: ${report.version}`, "", `Expected source commit: \`${report.sha}\`. ${report.counts.published}/${report.entries.length} packages match; ${report.counts.provenance} advertise provenance metadata.`, "",
    "| Package | Status | Source gitHead | Integrity | Provenance metadata |", "| --- | --- | --- | --- | --- |",
    ...report.entries.map((entry) => `| ${entry.name} | ${entry.status}${entry.reason === null ? "" : `: ${cell(entry.reason)}`} | ${cell(entry.gitHead ?? "missing")} | ${entry.integrity === null ? "missing" : "present"} | ${entry.provenance ? "present" : "absent"} |`), ""].join("\n")
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const usage = "Usage: bun scripts/release-status.ts [--root source] [--version X.Y.Z --sha <40hex>] [--wait 0..300] [--require-provenance]"
    if (args.includes("--help")) { console.log(usage); process.exit(0) }
    const flags = new Map<string, string>()
    const parse = (remaining: ReadonlyArray<string>): void => {
      if (remaining.length === 0) return
      const key = remaining[0]!
      if (flags.has(key) || !["--root", "--version", "--sha", "--wait", "--require-provenance"].includes(key)) throw new Error(usage)
      if (key === "--require-provenance") { flags.set(key, "true"); return parse(remaining.slice(1)) }
      const value = remaining[1]
      if (value === undefined || value.startsWith("--")) throw new Error(usage)
      flags.set(key, value)
      parse(remaining.slice(2))
    }
    parse(args)
    const explicitVersion = flags.get("--version")
    const explicitSha = flags.get("--sha")
    if ((explicitVersion === undefined) !== (explicitSha === undefined)) throw new Error("Supply both --version and --sha for a historical audit")
    const source = explicitVersion === undefined || explicitSha === undefined ? await releaseAuditSource(resolve(flags.get("--root") ?? resolve(import.meta.dir, ".."))) : { version: explicitVersion, sha: explicitSha }
    const waitSeconds = Number(flags.get("--wait") ?? "0")
    const report = await auditRelease({ ...source, waitSeconds, requireProvenance: flags.has("--require-provenance") })
    console.log(JSON.stringify(report, null, 2))
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryOf(report))
    if (!report.ok) process.exitCode = 1
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "The release audit failed")
    process.exitCode = 1
  }
}
