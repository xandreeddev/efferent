import { isAbsolute, join } from "node:path"
import { Effect, Option } from "effect"
import { FileSystem } from "@xandreed/engine"

/**
 * `@path` references in a composer message expand into inline file blocks
 * before the model sees the text — "look at @src/store.ts" carries the file
 * itself instead of hoping the model finds it. Deliberately bounded:
 *
 * - per-file cap + a total budget (the message must stay a message);
 * - binary content (NUL byte) is rejected with a note, never inlined;
 * - glob characters are not expanded (one ref = one file) — noted;
 * - a missing path is noted and the ref left as plain text.
 *
 * The original message text is preserved verbatim; expansions append as
 * clearly-labeled blocks after it.
 */

const FILE_CAP_CHARS = 8_000
const TOTAL_BUDGET_CHARS = 24_000
const REF_PATTERN = /@([\w~][\w.\/~*?-]*)/g

export interface ExpandedRefs {
  readonly text: string
  /** Human notes for the notice line ("@x: not found", "@y: binary"). */
  readonly notes: ReadonlyArray<string>
}

const clip = (s: string, cap: number): string =>
  s.length <= cap ? s : `${s.slice(0, cap)}\n[…clipped ${s.length - cap} chars…]`

export const expandFileRefs = (
  cwd: string,
  text: string,
): Effect.Effect<ExpandedRefs, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const refs = [...new Set([...text.matchAll(REF_PATTERN)].map((m) => m[1] ?? ""))].filter(
      (p) => p.length > 0,
    )
    if (refs.length === 0) return { text, notes: [] }
    const folded = yield* Effect.reduce(
      refs,
      { blocks: [] as ReadonlyArray<string>, notes: [] as ReadonlyArray<string>, used: 0 },
      (acc, ref) =>
        Effect.gen(function* () {
          if (/[*?[\]]/.test(ref)) {
            return { ...acc, notes: [...acc.notes, `@${ref}: globs are not expanded`] }
          }
          const path = isAbsolute(ref) ? ref : join(cwd, ref)
          const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
          if (!exists) {
            return { ...acc, notes: [...acc.notes, `@${ref}: not found`] }
          }
          if (acc.used >= TOTAL_BUDGET_CHARS) {
            return { ...acc, notes: [...acc.notes, `@${ref}: budget exhausted, not inlined`] }
          }
          const content = yield* fs.read(path).pipe(Effect.orElseSucceed(() => "\0"))
          if (content.includes("\0")) {
            return { ...acc, notes: [...acc.notes, `@${ref}: binary or unreadable, not inlined`] }
          }
          const body = clip(content, Math.min(FILE_CAP_CHARS, TOTAL_BUDGET_CHARS - acc.used))
          return {
            ...acc,
            blocks: [...acc.blocks, `[file: ${ref}]\n${body}`],
            used: acc.used + body.length,
          }
        }),
    )
    return {
      text:
        folded.blocks.length > 0 ? `${text}\n\n${folded.blocks.join("\n\n")}` : text,
      notes: folded.notes,
    }
  })
