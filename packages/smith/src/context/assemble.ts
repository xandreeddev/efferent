import { resolve } from "node:path"
import { Effect, Match, Option } from "effect"
import { FileSystem, Shell } from "@xandreed/core"
import { readRuns } from "@xandreed/foundry"
import { nativeGlob } from "../implementor/nativeSearch.js"
import { loadSpecDoc } from "../spec/store.js"
import type { ContextPin, ContextSet } from "./context-set.entity.js"
import { pinLabel, renderPinRef } from "./context-set.entity.functions.js"

/**
 * ASSEMBLY — the pinned sources become one bounded prompt block. Every pin
 * resolves to a block with a status the human can read back (included,
 * clipped, skipped over budget, missing, off, deferred), so what the model
 * saw is never a guess. Shell-backed pins (a diff, a command) only run when
 * the caller asks (`execute`) — a dashboard refresh must never execute the
 * human's commands. Pure over the ports; nothing here is advisory.
 */

export type BlockStatus = "included" | "clipped" | "skipped" | "missing" | "off" | "deferred"

export interface ContextBlock {
  readonly label: string
  readonly kind: ContextPin["_tag"]
  readonly chars: number
  readonly status: BlockStatus
  readonly text: Option.Option<string>
  readonly note: Option.Option<string>
}

export interface ContextBundle {
  readonly blocks: ReadonlyArray<ContextBlock>
  /** Characters the included blocks add to the turn. */
  readonly totalChars: number
  /** The prompt block, when at least one pin made it in. */
  readonly text: Option.Option<string>
  /** Stable over identical content — the injection seam's change detector. */
  readonly fingerprint: string
}

export interface AssembleOptions {
  /** Run diff/cmd pins (default true). `false` reports them as deferred. */
  readonly execute?: boolean
}

export const FILE_CAP_CHARS = 8_000
export const GLOB_FILES_CAP = 20
export const GLOB_FILE_CAP_CHARS = 3_000
export const DIR_ENTRIES_CAP = 200
export const DIFF_CAP_CHARS = 12_000
export const CMD_CAP_CHARS = 8_000
export const FEEDBACK_CAP_CHARS = 4_000
const SHELL_TIMEOUT_MS = 30_000

/** Tokens ≈ chars / 4 — the readout's honest approximation. */
export const approxTokens = (chars: number): number => Math.ceil(chars / 4)

const clipTo = (text: string, max: number): { readonly text: string; readonly clipped: boolean } =>
  text.length <= max
    ? { text, clipped: false }
    : { text: `${text.slice(0, max)}\n[…clipped at ${max} chars…]`, clipped: true }

/** FNV-1a over the text — pure, dependency-free, stable across processes. */
export const fingerprintOf = (text: string): string => {
  const hash = [...text].reduce((h, ch) => {
    const mixed = (h ^ ch.charCodeAt(0)) >>> 0
    return Math.imul(mixed, 16777619) >>> 0
  }, 2166136261)
  return hash.toString(16).padStart(8, "0")
}

interface Resolved {
  readonly text: Option.Option<string>
  readonly status: BlockStatus
  readonly note: Option.Option<string>
}

const ok = (text: string, clipped: boolean, note?: string): Resolved => ({
  text: Option.some(text),
  status: clipped ? "clipped" : "included",
  note: Option.fromNullable(note),
})
const missing = (note: string): Resolved => ({ text: Option.none(), status: "missing", note: Option.some(note) })
const deferred: Resolved = {
  text: Option.none(),
  status: "deferred",
  note: Option.some("runs when a turn assembles it"),
}

const readText = (
  path: string,
  cap: number,
): Effect.Effect<Option.Option<{ readonly text: string; readonly clipped: boolean }>, never, FileSystem> =>
  Effect.flatMap(FileSystem, (fs) =>
    fs.read(path).pipe(
      Effect.map((content) =>
        content.includes("\0") ? Option.none() : Option.some(clipTo(content, cap)),
      ),
      Effect.orElseSucceed(() => Option.none()),
    ),
  )

const listDir = (path: string): Effect.Effect<Option.Option<string>, never, FileSystem> =>
  Effect.flatMap(FileSystem, (fs) =>
    fs.list(path).pipe(
      Effect.map((names) => {
        const sorted = [...names].sort()
        const shown = sorted.slice(0, DIR_ENTRIES_CAP)
        const more = sorted.length - shown.length
        return Option.some(
          `${shown.map((name) => `- ${name}`).join("\n")}${more > 0 ? `\n[…${more} more entries…]` : ""}`,
        )
      }),
      Effect.orElseSucceed(() => Option.none<string>()),
    ),
  )

const resolveFile = (cwd: string, path: string) =>
  Effect.gen(function* () {
    const abs = resolve(cwd, path)
    const read = yield* readText(abs, FILE_CAP_CHARS)
    if (Option.isSome(read)) return ok(read.value.text, read.value.clipped)
    // A path that reads as a directory lists instead — the human's intent
    // was "this", not "this file".
    const listing = yield* listDir(abs)
    return Option.match(listing, {
      onNone: () => missing("not found, binary, or unreadable"),
      onSome: (text) => ok(text, false, "a directory — listed"),
    })
  })

const resolveDir = (cwd: string, path: string) =>
  Effect.map(listDir(resolve(cwd, path)), (listing) =>
    Option.match(listing, {
      onNone: () => missing("not a directory, or unreadable"),
      onSome: (text) => ok(text, false),
    }),
  )

const resolveGlob = (cwd: string, pattern: string) =>
  Effect.gen(function* () {
    const hits = yield* nativeGlob(cwd, pattern).pipe(
      Effect.map((r) => Option.some(r)),
      Effect.orElseSucceed(() => Option.none<{ readonly paths: ReadonlyArray<string>; readonly truncated: boolean }>()),
    )
    if (Option.isNone(hits)) return missing("the glob is not valid")
    const paths = hits.value.paths.slice(0, GLOB_FILES_CAP)
    if (paths.length === 0) return missing("no file matches")
    const blocks = yield* Effect.forEach(paths, (abs) =>
      Effect.map(readText(abs, GLOB_FILE_CAP_CHARS), (read) =>
        Option.map(read, (r) => ({
          text: `[file: ${abs.startsWith(cwd) ? abs.slice(cwd.length + 1) : abs}]\n${r.text}`,
          clipped: r.clipped,
        })),
      ),
    )
    const kept = blocks.flatMap(Option.toArray)
    if (kept.length === 0) return missing("every match is binary or unreadable")
    const over = hits.value.paths.length > GLOB_FILES_CAP || hits.value.truncated
    return ok(
      kept.map((b) => b.text).join("\n\n"),
      kept.some((b) => b.clipped) || over,
      `${kept.length} file${kept.length === 1 ? "" : "s"}${over ? ` (first ${GLOB_FILES_CAP} of more)` : ""}`,
    )
  })

const resolveSpec = (cwd: string, slug: string) =>
  loadSpecDoc(cwd, slug).pipe(
    Effect.map((doc) => {
      const bullets = (items: ReadonlyArray<string>) => items.map((i) => `- ${i}`).join("\n")
      const section = (title: string, items: ReadonlyArray<string>) =>
        items.length === 0 ? "" : `\n\n${title}\n${bullets(items)}`
      return ok(
        `Reference spec ${String(doc.slug)} (${doc.status}) — for context, not the task.\n\n${doc.goal}${section("Acceptance:", doc.acceptance)}${section("Constraints:", doc.constraints)}${section("Non-goals:", doc.nonGoals)}`,
        false,
      )
    }),
    Effect.catchAll((error) => Effect.succeed(missing(error.message))),
  )

const resolveRun = (cwd: string, id: string) =>
  Effect.map(readRuns(`${cwd}/.foundry/runs`), (runs) =>
    Option.match(Option.fromNullable(runs.find((r) => String(r.id).startsWith(id))), {
      onNone: () => missing("no such run on file"),
      onSome: (run) => {
        const last = run.attempts[run.attempts.length - 1]
        const outcome =
          run.outcome._tag === "accepted"
            ? `accepted (attempt ${run.outcome.attempt})`
            : run.outcome._tag === "rejected"
              ? `rejected — ${run.outcome.reason}`
              : "in flight"
        const gates = (last?.report.verdicts ?? [])
          .map((v) => `${v._tag === "pass" ? "✓" : v._tag === "fail" ? "✗" : "◌"} ${String(v.gate)}`)
          .join(" · ")
        const feedback = Option.getOrElse(
          Option.flatMap(Option.fromNullable(last), (a) => a.feedback),
          () => "(no gate feedback recorded — the last attempt was accepted)",
        )
        const body = clipTo(feedback, FEEDBACK_CAP_CHARS)
        return ok(
          `Forge run ${String(run.id).slice(0, 8)} — ${outcome} · ${run.attempts.length} attempt(s)\n${run.spec.goal}\n\ngates: ${gates}\n\nlast feedback:\n${body.text}`,
          body.clipped,
        )
      },
    }),
  )

const resolveShell = (cwd: string, command: string, cap: number, execute: boolean, header: string) =>
  !execute
    ? Effect.succeed(deferred)
    : Effect.flatMap(Shell, (shell) =>
        shell.exec(command, { cwd, timeoutMs: SHELL_TIMEOUT_MS }).pipe(
          Effect.map((result) => {
            const out = [result.stdout.trimEnd(), result.stderr.trim().length > 0 ? `[stderr]\n${result.stderr.trim()}` : ""]
              .filter((part) => part.length > 0)
              .join("\n")
            const body = clipTo(out.length > 0 ? out : "(no output)", cap)
            return ok(`${header} (exit ${result.exitCode})\n${body.text}`, body.clipped)
          }),
          Effect.catchAll((error) => Effect.succeed(missing(`could not run: ${error.message}`))),
        ),
      )

const resolvePin = (
  cwd: string,
  pin: ContextPin,
  execute: boolean,
): Effect.Effect<Resolved, never, FileSystem | Shell> =>
  Match.value(pin).pipe(
    Match.tag("file", (p) => resolveFile(cwd, p.path)),
    Match.tag("dir", (p) => resolveDir(cwd, p.path)),
    Match.tag("glob", (p) => resolveGlob(cwd, p.pattern)),
    Match.tag("note", (p) => Effect.succeed(ok(p.text, false))),
    Match.tag("spec", (p) => resolveSpec(cwd, p.slug)),
    Match.tag("run", (p) => resolveRun(cwd, p.id)),
    Match.tag("diff", (p) =>
      resolveShell(
        cwd,
        Option.match(p.ref, { onNone: () => "git diff", onSome: (ref) => `git diff ${ref}` }),
        DIFF_CAP_CHARS,
        execute,
        Option.match(p.ref, { onNone: () => "$ git diff", onSome: (ref) => `$ git diff ${ref}` }),
      ),
    ),
    Match.tag("cmd", (p) => resolveShell(cwd, p.command, CMD_CAP_CHARS, execute, `$ ${p.command}`)),
    Match.exhaustive,
  )

const renderBlock = (block: ContextBlock): string =>
  `### ${block.label} (${block.kind})\n${Option.getOrElse(block.text, () => "")}`

export const assembleContext = (
  cwd: string,
  set: ContextSet,
  options: AssembleOptions = {},
): Effect.Effect<ContextBundle, never, FileSystem | Shell> =>
  Effect.gen(function* () {
    const execute = options.execute ?? true
    const resolved = yield* Effect.forEach(set.pins, (pin) =>
      !pin.on
        ? Effect.succeed<ContextBlock>({
            label: pinLabel(pin),
            kind: pin._tag,
            chars: 0,
            status: "off",
            text: Option.none(),
            note: Option.none(),
          })
        : Effect.map(
            resolvePin(cwd, pin, execute),
            (r): ContextBlock => ({
              label: pinLabel(pin),
              kind: pin._tag,
              chars: Option.match(r.text, { onNone: () => 0, onSome: (t) => t.length }),
              status: r.status,
              text: r.text,
              note: r.note,
            }),
          ),
    )
    // The budget fold: blocks ride in pin order until one would overflow —
    // that one (and any later one that would) is SKIPPED, never silently
    // truncated into a half-file the model reads as whole.
    const budgeted = resolved.reduce<{ readonly used: number; readonly blocks: ReadonlyArray<ContextBlock> }>(
      (acc, block) => {
        if (Option.isNone(block.text)) return { ...acc, blocks: [...acc.blocks, block] }
        const fits = acc.used + block.chars <= set.budgetChars
        return fits
          ? { used: acc.used + block.chars, blocks: [...acc.blocks, block] }
          : {
              ...acc,
              blocks: [
                ...acc.blocks,
                { ...block, status: "skipped", text: Option.none(), note: Option.some(`over the ${set.budgetChars}-char budget`) },
              ],
            }
      },
      { used: 0, blocks: [] },
    )
    const included = budgeted.blocks.filter((b) => Option.isSome(b.text))
    const body = included.map(renderBlock).join("\n\n")
    const text =
      included.length === 0
        ? Option.none<string>()
        : Option.some(
            `## Context selected by the human (${included.length} source${included.length === 1 ? "" : "s"}, ~${approxTokens(budgeted.used)} tokens) — reference material for the task; the spec and the conversation still lead.\n\n${body}`,
          )
    return {
      blocks: budgeted.blocks,
      totalChars: budgeted.used,
      text,
      fingerprint: fingerprintOf(Option.getOrElse(text, () => "")),
    }
  })

/** One line per source for the pane and the panel: `src/x.ts 3.2k · note 0.1k · diff deferred`. */
export const bundleSummary = (bundle: ContextBundle): string =>
  bundle.blocks
    .map((b) =>
      b.status === "included" || b.status === "clipped"
        ? `${b.label} ${fmtChars(b.chars)}${b.status === "clipped" ? " (clipped)" : ""}`
        : `${b.label} ${b.status}`,
    )
    .join(" · ")

export const fmtChars = (chars: number): string =>
  chars >= 1_000 ? `${(chars / 1_000).toFixed(1)}k` : `${chars}`

/** The pins' refs, for the ledger and the tests. */
export const pinRefs = (set: ContextSet): ReadonlyArray<string> => set.pins.map(renderPinRef)
