#!/usr/bin/env bun
/**
 * The monorepo publisher — called by `bun run release` (which builds first:
 * typecheck → tests → build:libs → CLI bundle → this). For each publishable
 * package whose `name@version` isn't already on npm, it:
 *
 *   • LIBS (`@xandreed/sdk-core|sdk-adapters|evals`): rewrites the manifest for
 *     publish — `main`/`types`/`exports` → `dist`, `files` → ["dist"], and every
 *     `@xandreed/*` `workspace:*` dep → a real `^<version>` range (npm can't
 *     resolve the workspace protocol) — `npm publish --provenance`, then restores
 *     the committed (dev-facing, src-pointing) manifest via `git checkout`.
 *   • CLI (`efferent`): publishes the Bun bundle as-is, then the rename trick →
 *     `@xandreed/cli` (same bundle, kept in sync), then restores.
 *
 * Auth is npm **trusted publishing** (OIDC) in CI — no token. Prints
 * `New tag: <name>@<version>` per published package so `changesets/action`
 * creates the git tags + GitHub releases. `--dry-run` packs without publishing.
 *
 * This is an edge script (not core) — try/catch is allowed here.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const DRY = process.argv.includes("--dry-run")
// Optional package-name filter (positional args) — a per-package publish workflow
// passes its own name, e.g. `bun scripts/publish.ts @xandreed/sdk-core`. Empty ⇒ all.
const ONLY = new Set(process.argv.slice(2).filter((a) => !a.startsWith("-")))

type Kind = "lib" | "cli"
const PUBLISHABLE: ReadonlyArray<{ dir: string; kind: Kind }> = [
  { dir: "packages/sdk-core", kind: "lib" },
  { dir: "packages/sdk-adapters", kind: "lib" },
  { dir: "packages/evals", kind: "lib" },
  { dir: "packages/cli", kind: "cli" },
]

interface Manifest {
  name: string
  version: string
  [k: string]: unknown
}

const run = (cmd: string, args: string[], cwd: string): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const manifestPath = (dir: string): string => join(ROOT, dir, "package.json")

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(manifestPath(dir), "utf8")) as Manifest

const writeManifest = (dir: string, m: Manifest): void =>
  writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2) + "\n")

// name → version across the workspace, for rewriting workspace:* ranges.
const versions = new Map<string, string>()
for (const { dir } of PUBLISHABLE) {
  const m = readManifest(dir)
  versions.set(m.name, m.version)
}

/** Already on npm? (a brand-new scoped name 404s ⇒ false ⇒ we attempt it.) */
const isPublished = (name: string, version: string): boolean =>
  run("npm", ["view", `${name}@${version}`, "version"], ROOT).code === 0

/** workspace:* → ^<version>; workspace:<range> → <range>; else unchanged. */
const resolveRange = (value: string): string => {
  if (!value.startsWith("workspace:")) return value
  const rest = value.slice("workspace:".length)
  if (rest === "" || rest === "*" || rest === "^" || rest === "~") {
    // The dependent should pin the SDK it was built against — read its version.
    return rest === "~" ? "~" : "^"
  }
  return rest
}

const rewriteWorkspaceDeps = (m: Manifest): void => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = m[field] as Record<string, string> | undefined
    if (!deps) continue
    for (const [dep, value] of Object.entries(deps)) {
      if (!value.startsWith("workspace:")) continue
      const depVersion = versions.get(dep)
      if (depVersion === undefined) continue // external workspace? leave it
      const prefix = resolveRange(value) // "^" | "~" | an explicit range
      deps[dep] = prefix === "^" || prefix === "~" ? `${prefix}${depVersion}` : prefix
    }
  }
}

/** Point a library manifest at its built dist (publish-time only). */
const pointToDist = (m: Manifest): void => {
  m.main = "./dist/index.js"
  m.types = "./dist/index.d.ts"
  m.exports = {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./*": { types: "./dist/*.d.ts", import: "./dist/*.js" },
  }
  m.files = ["dist"]
}

const npmPublish = (dir: string): number => {
  // --provenance requires a supported CI + OIDC (GitHub Actions); locally (a
  // dry-run, or a one-time bootstrap publish from a logged-in CLI) it errors, so
  // only attach it when actually running in CI.
  const provenance = !DRY && process.env.GITHUB_ACTIONS === "true"
  const ci = process.env.GITHUB_ACTIONS === "true"
  const args = [
    "publish",
    ...(DRY ? ["--dry-run"] : []),
    ...(provenance ? ["--provenance"] : []),
    // Local bootstrap: force web auth so npm opens the browser for 2FA and POLLS
    // until you authorize (otherwise it exits instantly with EOTP, no TTY).
    ...(!DRY && !ci ? ["--auth-type=web"] : []),
  ]
  const r = spawnSync("npm", args, { cwd: join(ROOT, dir), stdio: "inherit" })
  return r.status ?? 1
}

const auditCliBundle = (): void => {
  const bundle = join(ROOT, "packages/cli/dist/efferent.js")
  if (!existsSync(bundle)) throw new Error("CLI bundle missing — run `bun run build` first")
  const text = readFileSync(bundle, "utf8")
  if (/\/home\/[a-z]|\/Users\/[a-z]/.test(text)) {
    throw new Error("build-machine path found in the CLI bundle — aborting publish")
  }
}

// Cheap pre-pass (npm view only): figure out what's actually unpublished BEFORE
// building. `changesets/action` calls this on EVERY main push with no pending
// changesets, so a no-op run must stay cheap and never build.
const toPublish = PUBLISHABLE.filter(({ dir }) => {
  const m = readManifest(dir)
  if (ONLY.size > 0 && !ONLY.has(m.name)) return false
  return !isPublished(m.name, m.version)
})
if (toPublish.length === 0) {
  console.log("Nothing to publish — every package version is already on npm.")
  process.exit(0)
}
console.log(
  `To publish: ${toPublish.map(({ dir }) => { const m = readManifest(dir); return `${m.name}@${m.version}` }).join(", ")}`,
)

// Build only what we're actually publishing (so a single-package workflow / a
// no-op push stays cheap). The merge that triggered this was already gated by
// ci.yml; `tsc -b` + the bundle build re-typecheck on the way to emit.
const buildSteps = [
  ...(toPublish.some((p) => p.kind === "lib") ? ["build:libs"] : []),
  ...(toPublish.some((p) => p.kind === "cli") ? ["build"] : []),
]
for (const step of buildSteps) {
  const r = run("bun", ["run", step], ROOT)
  process.stdout.write(r.stdout)
  process.stderr.write(r.stderr)
  if (r.code !== 0) {
    console.error(`✗ ${step} failed — aborting publish`)
    process.exit(1)
  }
}

const published: string[] = []
let failed = false

for (const { dir, kind } of PUBLISHABLE) {
  // Snapshot the exact committed (dev, src-pointing) manifest bytes so we can
  // restore them verbatim after the publish rewrite — no git dependency.
  const original = readFileSync(manifestPath(dir), "utf8")
  const committed = JSON.parse(original) as Manifest
  const { name, version } = committed

  if (ONLY.size > 0 && !ONLY.has(name)) continue

  if (isPublished(name, version)) {
    console.log(`• ${name}@${version} already on npm — skipping`)
    continue
  }

  if (kind === "cli") auditCliBundle()

  // Build the publish-time manifest (dist pointers for libs; deps resolved for both).
  const publishManifest: Manifest = JSON.parse(JSON.stringify(committed))
  if (kind === "lib") pointToDist(publishManifest)
  rewriteWorkspaceDeps(publishManifest)

  try {
    writeManifest(dir, publishManifest)
    const code = npmPublish(dir)
    if (code === 0) {
      console.log(`New tag: ${name}@${version}`)
      published.push(`${name}@${version}`)
    } else {
      console.error(`✗ publish failed for ${name}@${version} (exit ${code})`)
      failed = true
    }

    // CLI mirror: same bundle under @xandreed/cli. Non-fatal — it needs its own
    // trusted-publisher configured on npmjs.com; a missing one shouldn't block
    // the primary `efferent` release.
    if (kind === "cli" && code === 0) {
      const mirror: Manifest = JSON.parse(JSON.stringify(publishManifest))
      mirror.name = "@xandreed/cli"
      writeManifest(dir, mirror)
      const mcode = npmPublish(dir)
      if (mcode === 0) {
        // Log WITHOUT the magic `New tag:` prefix: changesets/action greps that
        // prefix to create a git tag + GitHub release per line, then looks the
        // name up in the workspace. `@xandreed/cli` is only a publish-time alias
        // of `efferent` (not a workspace package), so emitting `New tag:` for it
        // makes the action fail with `Package "@xandreed/cli" not found` AFTER a
        // successful npm publish — turning a green release red and skipping the
        // real packages' GitHub releases. The bundle is identical to efferent's.
        console.log(`Mirrored: @xandreed/cli@${version} (alias of efferent, same bundle)`)
        published.push(`@xandreed/cli@${version}`)
      } else {
        console.error(`⚠ @xandreed/cli mirror publish failed (exit ${mcode}) — primary efferent is published; configure its trusted publisher on npmjs.com`)
      }
    }
  } finally {
    writeFileSync(manifestPath(dir), original)
  }
}

console.log("")
console.log(published.length > 0 ? `Published: ${published.join(", ")}` : "Nothing to publish.")
if (failed) process.exit(1)
