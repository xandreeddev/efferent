import { basename } from "node:path"
import { Effect, Option } from "effect"
import {
  decodeSpecDocText,
  encodeSpecDocText,
  FileSystem,
  SPECS_DIR,
  SpecDoc,
  specSlug,
  uniqueSlug,
} from "@xandreed/sdk-core"
import type { SpecDocParseError, SpecSlug } from "@xandreed/sdk-core"
import { ConfigError } from "@xandreed/foundry"

/** Absolute path of a spec file in `cwd`'s workspace. */
export const specPath = (cwd: string, slug: SpecSlug | string): string =>
  `${cwd}/${SPECS_DIR}/${slug}.md`

const isPathRef = (ref: string): boolean => ref.includes("/") || ref.endsWith(".md")

const slugOfPath = (path: string): string => basename(path).replace(/\.md$/, "")

/**
 * Load a SpecDoc by slug or file path. Errors are `ConfigError` (the driver's
 * flag/input error type): missing file, undecodable content.
 */
export const loadSpecDoc = (
  cwd: string,
  ref: string,
): Effect.Effect<SpecDoc, ConfigError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const path = isPathRef(ref) ? ref : specPath(cwd, ref)
    const read = yield* fs.read(path).pipe(
      Effect.mapError(
        () =>
          new ConfigError({
            path,
            message: `spec not found — expected ${SPECS_DIR}/<slug>.md (have: ${ref})`,
          }),
      ),
    )
    return yield* decodeSpecDocText(slugOfPath(path), read.content).pipe(
      Effect.mapError(
        (error: SpecDocParseError) => new ConfigError({ path, message: error.message }),
      ),
    )
  })

export const writeSpecDoc = (
  cwd: string,
  doc: SpecDoc,
): Effect.Effect<string, ConfigError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const path = specPath(cwd, doc.slug)
    yield* fs.write(path, encodeSpecDocText(doc)).pipe(
      Effect.mapError((error) => new ConfigError({ path, message: String(error) })),
    )
    return path
  })

/** Lock a draft: `status: locked` + timestamp, rewritten in place. */
export const lockSpecDoc = (
  cwd: string,
  doc: SpecDoc,
  at: string,
): Effect.Effect<SpecDoc, ConfigError, FileSystem> =>
  Effect.gen(function* () {
    const locked = new SpecDoc({ ...doc, status: "locked", locked: Option.some(at) })
    yield* writeSpecDoc(cwd, locked)
    return locked
  })

/** Slugs of every spec in the workspace (empty when the dir is absent). */
export const listSpecs = (cwd: string): Effect.Effect<ReadonlyArray<string>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const entries = yield* fs
      .list(`${cwd}/${SPECS_DIR}`, { recursive: false })
      .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<{ path: string }>)))
    return entries
      .map((entry) => slugOfPath(entry.path))
      .filter((slug) => slug.length > 0)
      .sort()
  })

/** Mint a workspace-unique slug from a goal (first-wins suffixing). */
export const mintUniqueSlug = (
  cwd: string,
  goal: string,
): Effect.Effect<SpecSlug, never, FileSystem> =>
  Effect.map(listSpecs(cwd), (taken) => {
    const set = new Set(taken)
    return uniqueSlug(specSlug(goal), (candidate) => set.has(candidate))
  })
