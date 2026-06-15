#!/usr/bin/env bun
/**
 * Install the local git pre-commit hook for the core-purity ban.
 *
 * Runs automatically via the root `prepare` script on `bun install`, giving
 * contributors fast local feedback before code reaches CI. It is a convenience,
 * not the guarantee: `git commit --no-verify` bypasses it, so the real lock is
 * the `ci` workflow + branch protection on `main`.
 *
 * No-op outside a normal git checkout (dependency installs, worktrees, tarballs).
 * Never clobbers a pre-existing hook it didn't write.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const MARKER = "efferent core-purity hook"
const HOOK = `#!/bin/sh
# ${MARKER} — core stays pure (errors are values). Bypass (discouraged): git commit --no-verify
exec bun scripts/banTryCatch.ts
`

const ROOT = join(import.meta.dir, "..")
const gitDir = join(ROOT, ".git")

// Only a standard checkout has a .git directory. A worktree/submodule points at
// .git via a file; a dependency install has none. Either way, nothing to install.
if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) {
  process.exit(0)
}

const hooksDir = join(gitDir, "hooks")
mkdirSync(hooksDir, { recursive: true })
const hookPath = join(hooksDir, "pre-commit")

if (existsSync(hookPath) && !readFileSync(hookPath, "utf-8").includes(MARKER)) {
  console.error("• existing pre-commit hook left untouched — add `bun scripts/banTryCatch.ts` to it manually")
  process.exit(0)
}

writeFileSync(hookPath, HOOK, { mode: 0o755 })
console.error("✓ installed .git/hooks/pre-commit (core-purity ban)")
