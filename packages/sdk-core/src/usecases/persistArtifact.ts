import { resolve } from "node:path"
import { Context, Effect } from "effect"
import type { Candidate } from "../entities/Distillation.js"
import {
  FileSystem,
  type FileNotFound,
  type FileSystemError,
  type PermissionDenied,
} from "../ports/FileSystem.js"

/**
 * The self-improving loop's **Curator** (`docs/self-improving-loop.md`) — and it
 * is *pure code*: no LLM ever rewrites a library file. That's the ACE
 * context-collapse rule (an LLM asked to fold a file into itself compresses the
 * detail away) and the prompt-cache rule (a wholesale rewrite invalidates the
 * prefix) in one. Each verified candidate is merged as a **delta item**:
 *
 * - `constraint` → a bullet appended/updated in place in `.efferent/CONSTRAINTS.md`
 *   (`- [id] (✓helpful ✗harmful) rule`). Auto-loaded as the `# Constraints` section.
 * - `skill` → `.efferent/skills/<slug>.md` (the first programmatic skill write).
 * - `memory` → `.efferent/memory/<slug>.md` (the `remember`-tool append shape).
 */

export interface PersistResult {
  readonly path: string
  readonly created: boolean
  readonly kind: Candidate["kind"]
}

type PersistError = FileSystemError | PermissionDenied | FileNotFound

/** Kebab slug for a filename / bullet id (mirrors the `remember` tool's slug). */
export const slugifyName = (s: string): string => {
  const slug = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return slug.length > 0 ? slug : "note"
}

const firstLine = (s: string): string => {
  const line = s.split("\n").find((l) => l.trim() !== "")?.trim() ?? ""
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

export const persistArtifact = (
  /** The PROJECT root (`<repo>`); a `project`-scoped learning lands under its `.efferent/`. */
  displayRoot: string,
  candidate: Candidate,
  now: Date = new Date(),
  /** The GLOBAL root (`~`); a `global`-scoped learning lands under ITS `.efferent/`,
   *  loaded into every workspace. Omit ⇒ everything stays project-local (back-compat). */
  globalRoot?: string,
): Effect.Effect<PersistResult, PersistError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    // Route the WRITE by scope. The read side already loads both ~/.efferent and
    // <repo>/.efferent (closer shadows farther), so a global learning is inherited
    // by every project; a project learning stays local.
    const dir =
      candidate.scope === "global" && globalRoot !== undefined ? globalRoot : displayRoot
    switch (candidate.kind) {
      case "constraint":
        return yield* persistConstraint(fs, dir, candidate)
      case "skill":
        return yield* persistSkill(fs, dir, candidate, now)
      case "memory":
        return yield* persistMemory(fs, dir, candidate, now)
    }
  })

// --- constraint: a delta-item bullet, append/update-in-place, never rewrite ---

const persistConstraint = (
  fs: Context.Tag.Service<typeof FileSystem>,
  displayRoot: string,
  c: Candidate,
): Effect.Effect<PersistResult, PersistError> =>
  Effect.gen(function* () {
    const abs = resolve(displayRoot, ".efferent/CONSTRAINTS.md")
    const id = slugifyName(c.name)
    const rule = c.body.trim().replace(/\s+/g, " ")
    const exists = yield* fs.exists(abs)
    if (!exists) {
      const doc =
        `# Constraints\n\n` +
        `Hard rules distilled from past runs by the self-improving loop and verified before they were saved. ` +
        `Each line is a delta item: \`[id] (✓helpful ✗harmful) rule\`.\n\n` +
        `- [${id}] (✓0 ✗0) ${rule}\n`
      yield* fs.write(abs, doc)
      return { path: abs, created: true, kind: "constraint" as const }
    }
    const before = (yield* fs.read(abs)).content
    const lines = before.split("\n")
    const idx = lines.findIndex((l) => l.includes(`[${id}]`))
    if (idx >= 0) {
      // Update in place: keep the existing counters, refresh the rule text.
      const counters = lines[idx]?.match(/\((✓\d+\s*✗\d+)\)/)?.[0] ?? "(✓0 ✗0)"
      lines[idx] = `- [${id}] ${counters} ${rule}`
      yield* fs.write(abs, lines.join("\n"))
      return { path: abs, created: false, kind: "constraint" as const }
    }
    const next = `${before.replace(/\n+$/, "")}\n- [${id}] (✓0 ✗0) ${rule}\n`
    yield* fs.write(abs, next)
    return { path: abs, created: false, kind: "constraint" as const }
  })

// --- skill: one file per skill; grow-and-refine never clobbers an existing one ---

const persistSkill = (
  fs: Context.Tag.Service<typeof FileSystem>,
  displayRoot: string,
  c: Candidate,
  now: Date,
): Effect.Effect<PersistResult, PersistError> =>
  Effect.gen(function* () {
    const slug = slugifyName(c.name)
    const abs = resolve(displayRoot, ".efferent/skills", `${slug}.md`)
    const exists = yield* fs.exists(abs)
    // Grow-and-refine: a name collision means we already learned this — don't
    // clobber a (possibly human-edited) skill. A real conflict is a supersede
    // decision for the maintenance pass, not a blind overwrite here.
    if (exists) return { path: abs, created: false, kind: "skill" as const }
    const doc =
      `---\n` +
      `name: ${slug}\n` +
      `description: ${c.description.replace(/\s+/g, " ").trim()}\n` +
      `source: distilled\n` +
      `learned: ${now.toISOString().slice(0, 10)}\n` +
      `evidence: ${c.evidence.conversationId}\n` +
      `helpful: 0\n` +
      `harmful: 0\n` +
      `---\n\n` +
      `${c.body.trim()}\n`
    yield* fs.write(abs, doc)
    return { path: abs, created: true, kind: "skill" as const }
  })

// --- memory: the `remember` tool's append-not-clobber shape ---

const persistMemory = (
  fs: Context.Tag.Service<typeof FileSystem>,
  displayRoot: string,
  c: Candidate,
  now: Date,
): Effect.Effect<PersistResult, PersistError> =>
  Effect.gen(function* () {
    const slug = slugifyName(c.name)
    const abs = resolve(displayRoot, ".efferent/memory", `${slug}.md`)
    const title = c.description.trim() !== "" ? c.description.trim() : slug
    const stamp = now.toISOString()
    const exists = yield* fs.exists(abs)
    if (exists) {
      const before = (yield* fs.read(abs)).content
      const entry = `\n## ${stamp} — ${title}\n\n${c.body.trim()}\n`
      yield* fs.write(abs, `${before.replace(/\n+$/, "")}\n${entry}`)
      return { path: abs, created: false, kind: "memory" as const }
    }
    const doc =
      `---\ntitle: ${title}\nsummary: ${firstLine(c.body)}\n---\n\n` +
      `# ${title}\n\n## ${stamp}\n\n${c.body.trim()}\n`
    yield* fs.write(abs, doc)
    return { path: abs, created: true, kind: "memory" as const }
  })
