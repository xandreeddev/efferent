import { isAbsolute, relative, resolve, sep } from "node:path"
import { Tool, Toolkit } from "@effect/ai"
import { Effect, Schema } from "effect"
import {
  type Memory,
  type Skill,
  Approval,
  bashRuleKey,
  FileSystem,
  Http,
  Shell,
  WebSearch as WebSearchPort,
  Failure,
  toFailure,
} from "@xandreed/sdk-core"

/**
 * The coding tools as an `@effect/ai` Toolkit. Each tool ships explicit
 * `success`/`failure` Structs (Gemini's functionResponse must be an
 * object) with `failureMode: "return"` so a tool failure is handed back
 * to the model as data instead of aborting the turn. Handlers resolve
 * `FileSystem`/`Shell` from context at layer-build time; the runtime
 * scope (`rootDir`/`displayRoot`) is bound by `makeCodingHandlers(binding)`.
 */

const resolvePath = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path)

const displayPath = (cwd: string, path: string): string => {
  const rel = relative(cwd, path)
  return rel.startsWith("..") || rel.length === 0 ? path : rel
}

/**
 * True when `path` lives inside `rootDir` (or *is* `rootDir`). Uses
 * `path.sep` so `/foo/bar` isn't considered inside `/foo/bar-other`.
 */
const isWithinScope = (path: string, rootDir: string): boolean => {
  const root = rootDir.endsWith(sep) ? rootDir : rootDir + sep
  return path === rootDir || path.startsWith(root)
}

const stripFrontmatter = (content: string): string => {
  if (!content.startsWith("---")) return content
  const rest = content.slice(3)
  const lfIndex = rest.indexOf("\n")
  if (lfIndex === -1) return content
  const afterFirstFence = rest.slice(lfIndex + 1)
  const closeIndex = afterFirstFence.indexOf("\n---")
  if (closeIndex === -1) return content
  return afterFirstFence.slice(closeIndex + 4).replace(/^\n+/, "")
}

/**
 * Slugify a memory title/name into a safe `.md` filename stem: lowercased,
 * non-alphanumerics collapsed to single hyphens, trimmed. Falls back to
 * "memory" when nothing usable remains (e.g. an all-punctuation title).
 */
export const slugify = (s: string): string => {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return slug.length > 0 ? slug : "memory"
}

/** The first non-empty line of a block, trimmed — used as a memory's default summary. */
export const firstLine = (s: string): string =>
  s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? ""

/**
 * Accept either the canonical `edits: [{ oldText, newText }]` array or the
 * flat single-edit convenience form (top-level `oldText`/`newText`). Models
 * trained on Claude Code's `Edit` tool routinely drop the array wrapper for a
 * single edit and emit the flat shape — which used to fail *parameter decode*
 * (before our handler runs, so `failureMode: "return"` couldn't catch it) and
 * abort the whole turn. Normalising both shapes here lets the decode succeed;
 * an empty result is returned by the handler as a graceful tool failure.
 */
export const normalizeEdits = (args: {
  readonly edits?: ReadonlyArray<{ readonly oldText: string; readonly newText: string }> | undefined
  readonly oldText?: string | undefined
  readonly newText?: string | undefined
}): ReadonlyArray<{ oldText: string; newText: string }> => {
  if (args.edits !== undefined && args.edits.length > 0) {
    return args.edits.map((e) => ({ oldText: e.oldText, newText: e.newText }))
  }
  if (args.oldText !== undefined) {
    return [{ oldText: args.oldText, newText: args.newText ?? "" }]
  }
  return []
}

const applyEditsToContent = (
  content: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
): { result: string; error?: string } => {
  let current = content
  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText } = edits[i]!
    const idx = current.indexOf(oldText)
    if (idx === -1) {
      return {
        result: current,
        error: `edit ${i + 1} of ${edits.length}: oldText not found in file`,
      }
    }
    const next = current.indexOf(oldText, idx + oldText.length)
    if (next !== -1) {
      return {
        result: current,
        error: `edit ${i + 1} of ${edits.length}: oldText is ambiguous (matches multiple times); include more surrounding context`,
      }
    }
    current = current.slice(0, idx) + newText + current.slice(idx + oldText.length)
  }
  return { result: current }
}

type DiffOp = { readonly tag: "eq" | "del" | "add"; readonly line: string }

/**
 * Line-level LCS (longest common subsequence) via a flat DP table, then a
 * backtrack into a list of equal/delete/add ops in file order. Pure; no IO.
 */
const diffLines = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): DiffOp[] => {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + (j + 1)]!)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: "eq", line: a[i]! })
      i++
      j++
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) {
      ops.push({ tag: "del", line: a[i]! })
      i++
    } else {
      ops.push({ tag: "add", line: b[j]! })
      j++
    }
  }
  while (i < n) ops.push({ tag: "del", line: a[i++]! })
  while (j < m) ops.push({ tag: "add", line: b[j++]! })
  return ops
}

interface Hunk {
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: string[]
}

/**
 * Group an op list into unified-diff hunks, each padded with up to `context`
 * unchanged lines; change regions separated by ≤ 2·context equal lines merge
 * into one hunk. Emits in file order — fixes the old all-removes-then-adds,
 * single-giant-hunk behaviour for multi-region edits.
 */
const groupHunks = (ops: ReadonlyArray<DiffOp>, context: number): Hunk[] => {
  const changed = ops.map((o) => o.tag !== "eq")
  // 1-based old/new line number at each op position.
  const oldNo = new Array<number>(ops.length)
  const newNo = new Array<number>(ops.length)
  let o = 1
  let nw = 1
  for (let k = 0; k < ops.length; k++) {
    oldNo[k] = o
    newNo[k] = nw
    if (ops[k]!.tag !== "add") o++
    if (ops[k]!.tag !== "del") nw++
  }

  const hunks: Hunk[] = []
  let k = 0
  while (k < ops.length) {
    if (!changed[k]) {
      k++
      continue
    }
    const start = k
    let end = k
    let j = k
    while (j < ops.length) {
      if (changed[j]) {
        end = j
        j++
        continue
      }
      let e = j
      while (e < ops.length && !changed[e]) e++
      if (e < ops.length && e - j <= context * 2) {
        j = e // small gap between changes — absorb it
        continue
      }
      break
    }
    const ctxStart = Math.max(0, start - context)
    const ctxEnd = Math.min(ops.length - 1, end + context)
    const lines: string[] = []
    let oldCount = 0
    let newCount = 0
    for (let p = ctxStart; p <= ctxEnd; p++) {
      const op = ops[p]!
      lines.push((op.tag === "eq" ? " " : op.tag === "del" ? "-" : "+") + op.line)
      if (op.tag !== "add") oldCount++
      if (op.tag !== "del") newCount++
    }
    hunks.push({
      oldStart: oldNo[ctxStart]!,
      oldCount,
      newStart: newNo[ctxStart]!,
      newCount,
      lines,
    })
    k = ctxEnd + 1
  }
  return hunks
}

/**
 * Common prefix/suffix trim — one hunk, no context. Kept as the fallback for
 * inputs too large for the O(n·m) LCS table (over-reports the gap between
 * distant edits, but bounded memory).
 */
const trimmedDiff = (a: ReadonlyArray<string>, b: ReadonlyArray<string>, path: string): string => {
  let start = 0
  const maxStart = Math.min(a.length, b.length)
  while (start < maxStart && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const removed = a.slice(start, endA + 1)
  const added = b.slice(start, endB + 1)
  if (removed.length === 0 && added.length === 0) return ""
  const lines: string[] = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
  ]
  for (const l of removed) lines.push(`-${l}`)
  for (const l of added) lines.push(`+${l}`)
  return lines.join("\n")
}

/**
 * Unified diff over a real line-level LCS: multiple hunks in file order, each
 * with up to 3 context lines and a correct `@@ -old,n +new,m @@` header. The
 * renderer parses those headers for the line-number gutter, and the model
 * sees canonical unified-diff text. Falls back to a bounded prefix/suffix
 * trim for very large inputs.
 */
export const unifiedDiff = (before: string, after: string, path: string): string => {
  if (before === after) return ""
  const a = before.split("\n")
  const b = after.split("\n")
  // O(n·m) table guard — fall back to the bounded trim past ~2000² cells.
  if (a.length * b.length > 4_000_000) return trimmedDiff(a, b, path)
  const hunks = groupHunks(diffLines(a, b), 3)
  if (hunks.length === 0) return ""
  const lines: string[] = [`--- ${path}`, `+++ ${path}`]
  for (const h of hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`)
    lines.push(...h.lines)
  }
  return lines.join("\n")
}

const formatReadOutput = (
  content: string,
  startLine: number,
  truncated: boolean,
  totalLines: number,
): string => {
  const lines = content.split("\n")
  const numbered = lines
    .map((line, i) => `${String(startLine + i).padStart(5, " ")}\t${line}`)
    .join("\n")
  if (truncated) {
    return `${numbered}\n... (truncated; file has ${totalLines} lines total)`
  }
  return numbered
}

/**
 * Tool-level output cap: keep head + tail, drop the middle. The tail matters
 * — long runs END in their conclusion (exit summaries, "N pass / M fail"),
 * and a head-only cut erased exactly the lines compaction's log compression
 * most wants to keep. This cap bounds what a single call can return at all;
 * compaction (usecases/compaction.ts) is the context-budget backstop downstream.
 */
export const truncateOutput = (s: string, max: number): string => {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return (
    `${s.slice(0, head)}\n` +
    `... (truncated: ${s.length - max} bytes omitted from the middle of this output) ...\n` +
    `${s.slice(s.length - tail)}`
  )
}

/** Reduce HTML to readable text — drop script/style/tags, decode common entities. */
const htmlToText = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()

// Failure schema is imported from @xandreed/sdk-core

/**
 * A safe grep flag token: a short (`-i`, `-iw`) or long (`--ignore-case`) flag of
 * letters and hyphens only — no `=value`, no whitespace, no shell metacharacters.
 * `grep`'s `flags` arg is interpolated unquoted into a `bash -c` command, so every
 * token must match this or the call is rejected (it was a command-injection hole).
 */
const SAFE_GREP_FLAG = /^--?[A-Za-z][A-Za-z-]*$/

/**
 * Validate the user/model-supplied grep `flags` string. Returns `{ ok: true,
 * extra }` with the leading-space-prefixed, re-joined flags ready to splice into
 * the command, or `{ ok: false, bad }` naming the first token that isn't a
 * {@link SAFE_GREP_FLAG} — the handler turns that into a model-visible failure
 * rather than running it. Pure + exported so the guard is unit-tested directly.
 */
export type GrepFlags =
  | { readonly ok: true; readonly extra: string }
  | { readonly ok: false; readonly bad: string }

export const parseGrepFlags = (flags: string | undefined): GrepFlags => {
  if (flags === undefined) return { ok: true, extra: "" }
  const tokens = flags.trim().split(/\s+/).filter((t) => t.length > 0)
  const bad = tokens.find((t) => !SAFE_GREP_FLAG.test(t))
  if (bad !== undefined) return { ok: false, bad }
  return { ok: true, extra: tokens.length > 0 ? ` ${tokens.join(" ")}` : "" }
}

// toFailure function is imported from @xandreed/sdk-core

// ---- tool definitions ----

export const ReadFile = Tool.make("read_file", {
  description:
    "Read a file's contents with line numbers. Use offset/limit to page through large files.",
  parameters: {
    path: Schema.String.annotations({
      description: "Path to the file (relative to cwd, or absolute).",
    }),
    offset: Schema.optional(
      Schema.Number.annotations({ description: "1-indexed start line." }),
    ),
    limit: Schema.optional(
      Schema.Number.annotations({ description: "Max lines to return." }),
    ),
  },
  success: Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    totalLines: Schema.Number,
    truncated: Schema.Boolean,
  }),
  failure: Failure,
  failureMode: "return",
})

export const WriteFile = Tool.make("write_file", {
  description:
    "Create or fully replace a file. Use 'edit_file' instead for targeted in-place edits to existing files.",
  parameters: {
    path: Schema.String.annotations({
      description: "Path to the file (relative to cwd, or absolute).",
    }),
    content: Schema.String.annotations({
      description: "Full content to write. Overwrites any existing file.",
    }),
  },
  success: Schema.Struct({
    path: Schema.String,
    bytes: Schema.Number,
    lines: Schema.Number,
    /** Old→new unified diff (a new file = all-additions) — rendered below the pill. */
    diff: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

export const EditFile = Tool.make("edit_file", {
  description:
    "Apply targeted substring edits to a file. Each edit's oldText must match exactly once in the current file content. For multiple edits pass the `edits` array; for a single edit you may instead pass top-level `oldText`/`newText`.",
  parameters: {
    path: Schema.String.annotations({ description: "Path to the file to edit." }),
    edits: Schema.optional(
      Schema.Array(
        Schema.Struct({
          oldText: Schema.String.annotations({
            description:
              "Exact substring to find (whitespace and indentation included). Must be unique in the file.",
          }),
          newText: Schema.String.annotations({ description: "Replacement text." }),
        }),
      ).annotations({
        description:
          "One or more substring edits, applied in order. Each oldText must match exactly once. Omit if using the top-level oldText/newText single-edit form.",
      }),
    ),
    oldText: Schema.optional(
      Schema.String.annotations({
        description:
          "Single-edit form: exact substring to find (must match exactly once). Pair with newText; ignored when `edits` is provided.",
      }),
    ),
    newText: Schema.optional(
      Schema.String.annotations({
        description: "Single-edit form: replacement text for the top-level oldText.",
      }),
    ),
  },
  success: Schema.Struct({
    path: Schema.String,
    editsApplied: Schema.Number,
    diff: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

// NB: named "Bash" — the capital B is LOAD-BEARING, don't lowercase it.
// Anthropic reserves the lowercase names "bash"/"web_search"/"computer"/
// "code_execution"/"str_replace_*" for its built-in provider tools, and
// `@effect/ai-anthropic` rewrites those exact response tool names to its
// provider-defined tools (`AnthropicBash`, …) — which aren't in our toolkit,
// so the turn fails. The lookup is a case-sensitive `Map.get`, so "Bash" (the
// name Claude Code itself uses) sidesteps it while staying the well-trained
// name the model expects.
export const Bash = Tool.make("Bash", {
  description:
    "Execute a shell command in the workspace. Use for git, build, test, install, and other operations not covered by the other tools.",
  parameters: {
    command: Schema.String.annotations({
      description: "Shell command. Runs via 'bash -c' in the workspace cwd.",
    }),
    timeout: Schema.optional(
      Schema.Number.annotations({
        description: "Timeout in milliseconds. Defaults to 60000.",
      }),
    ),
  },
  success: Schema.Struct({
    exitCode: Schema.Number,
    stdout: Schema.String,
    stderr: Schema.String,
    durationMs: Schema.Number,
    timedOut: Schema.Boolean,
  }),
  failure: Failure,
  failureMode: "return",
})

export const Grep = Tool.make("grep", {
  description:
    "Search for a regex pattern across files. Returns matching lines with file:line:text. Respects .gitignore.",
  parameters: {
    pattern: Schema.String.annotations({
      description: "Regex to search for. Passed to GNU grep as ERE (-E).",
    }),
    dir: Schema.optional(
      Schema.String.annotations({
        description: "Directory to search in. Defaults to cwd.",
      }),
    ),
    flags: Schema.optional(
      Schema.String.annotations({
        description:
          "Extra grep flags, e.g. '-i' (case-insensitive) or '-w' (word match). -rnE are always set. Only bare flags (letters/hyphens, like -i, -iw, --ignore-case) are accepted — no '=value' forms or shell characters.",
      }),
    ),
    context: Schema.optional(
      Schema.Number.annotations({
        description: "Lines of surrounding context to include per match.",
      }),
    ),
  },
  success: Schema.Struct({
    dir: Schema.String,
    pattern: Schema.String,
    output: Schema.String,
    exitCode: Schema.Number,
  }),
  failure: Failure,
  failureMode: "return",
})

export const Glob = Tool.make("glob", {
  description:
    "Find files matching a glob pattern (e.g. '**/*.ts'). Respects .gitignore. Returns relative paths.",
  parameters: {
    pattern: Schema.String.annotations({
      description: "Glob pattern (e.g. '**/*.ts'). Respects .gitignore.",
    }),
    dir: Schema.optional(
      Schema.String.annotations({
        description: "Directory to glob in. Defaults to cwd.",
      }),
    ),
  },
  success: Schema.Struct({
    dir: Schema.String,
    pattern: Schema.String,
    matches: Schema.Array(Schema.String),
    truncated: Schema.Boolean,
    total: Schema.Number,
  }),
  failure: Failure,
  failureMode: "return",
})

export const Ls = Tool.make("ls", {
  description: "List a directory's entries. Use recursive: true to descend.",
  parameters: {
    path: Schema.optional(
      Schema.String.annotations({
        description: "Directory to list. Defaults to cwd.",
      }),
    ),
    recursive: Schema.optional(
      Schema.Boolean.annotations({ description: "Recurse into subdirectories." }),
    ),
  },
  success: Schema.Struct({
    path: Schema.String,
    entries: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        type: Schema.Literal("file", "dir"),
      }),
    ),
    truncated: Schema.Boolean,
    total: Schema.Number,
  }),
  failure: Failure,
  failureMode: "return",
})

export const ReadSkill = Tool.make("read_skill", {
  description:
    "Read the full body of a named skill (a markdown procedure). Use when a skill's name and one-line description in the prompt suggest it applies to the current task — then follow the steps described in the body.",
  parameters: {
    name: Schema.String.annotations({
      description:
        "Skill name (the value listed in the system prompt's Skills section).",
    }),
  },
  success: Schema.Struct({
    name: Schema.String,
    sourcePath: Schema.String,
    body: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

export const ReadMemory = Tool.make("read_memory", {
  description:
    "Read the full body of a named project-knowledge record (a durable note capturing an architecture decision, convention, or gotcha). Use when a record's title/summary in the prompt's Memory section looks relevant to the task — the index is intentionally terse, the body has the detail.",
  parameters: {
    name: Schema.String.annotations({
      description:
        "Memory name (the slug shown in the system prompt's Memory section).",
    }),
  },
  success: Schema.Struct({
    name: Schema.String,
    title: Schema.String,
    sourcePath: Schema.String,
    body: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

export const Remember = Tool.make("remember", {
  description:
    "Record durable project knowledge — an architecture decision, a convention, a gotcha worth keeping — into the workspace's `.efferent/memory/`. Use it the moment a decision is made or a non-obvious fact is learned, so future sessions read the distilled rationale instead of re-deriving it. Writes a markdown record (title + summary + your content); if a record with the same name already exists it APPENDS a timestamped entry (ADR-style log) rather than overwriting. Keep records small and curated — one topic each — not a dump of everything.",
  parameters: {
    title: Schema.String.annotations({
      description:
        "Short human-readable title for the record (e.g. 'Why we route per-request, not per-layer').",
    }),
    content: Schema.String.annotations({
      description:
        "The knowledge itself, as markdown. State the decision/fact and the WHY — the rationale is the point.",
    }),
    name: Schema.optional(
      Schema.String.annotations({
        description:
          "Optional slug for the file (`.efferent/memory/<name>.md`). Defaults to a slug of the title. Reuse an existing name to append a follow-up entry to that record.",
      }),
    ),
    summary: Schema.optional(
      Schema.String.annotations({
        description:
          "Optional one-line index summary. Defaults to the first line of `content`.",
      }),
    ),
  },
  success: Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    created: Schema.Boolean,
  }),
  failure: Failure,
  failureMode: "return",
})

export const WebFetch = Tool.make("web_fetch", {
  description:
    "Fetch a URL over HTTP(S) and return its content as readable text (HTML is reduced to text). Use for documentation, references, or pages the user links.",
  parameters: {
    url: Schema.String.annotations({
      description: "Absolute http(s) URL to fetch.",
    }),
    maxBytes: Schema.optional(
      Schema.Number.annotations({
        description: "Max bytes of body to read. Defaults to 50000.",
      }),
    ),
  },
  success: Schema.Struct({
    url: Schema.String,
    status: Schema.Number,
    contentType: Schema.String,
    content: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

// Named "search_web", not "web_search" — see the note on `Bash` above
// (Anthropic reserves "web_search" for its built-in provider tool).
export const WebSearchTool = Tool.make("search_web", {
  description:
    "Search the web for current information and get a short synthesized answer with source URLs. Use it to find things you don't know or that may have changed — library versions, API docs, recent events — when you don't already have a URL. It returns a summary plus its sources; call web_fetch on a source url to read that page in full.",
  parameters: {
    query: Schema.String.annotations({
      description:
        "What to search for. Prefer specific keywords over a long question; add a year or 'latest' when currency matters.",
    }),
  },
  success: Schema.Struct({
    answer: Schema.String,
    sources: Schema.Array(
      Schema.Struct({ title: Schema.String, url: Schema.String }),
    ),
  }),
  failure: Failure,
  failureMode: "return",
})

export const PlanStepStatus = Schema.Literal("pending", "active", "done")
export type PlanStepStatus = typeof PlanStepStatus.Type

export const PlanStep = Schema.Struct({
  step: Schema.String.annotations({
    description: "One short step (≤ 10 words), imperative — e.g. 'add the title column'.",
  }),
  status: PlanStepStatus,
})
export type PlanStep = typeof PlanStep.Type

/**
 * The working-plan tool: a short, user-visible checklist the model maintains
 * while it works. Pure data — each call REPLACES the plan wholesale (no ids,
 * no diffing), the UI renders the latest call's steps, and a session switch
 * rebuilds the plan from the last call in the loaded history.
 */
export const UpdatePlan = Tool.make("update_plan", {
  description:
    "Maintain your working plan for the current task — a short checklist the user sees live. " +
    "For any multi-step task (3+ distinct steps), call this FIRST with the full plan, then " +
    "again after finishing each step. Every call REPLACES the whole plan, so always send the " +
    "complete list. Keep steps short and concrete, statuses honest (mark 'done' only when " +
    "actually done), and exactly one step 'active' while you work. Skip it for trivial " +
    "single-step asks.",
  parameters: {
    steps: Schema.Array(PlanStep).annotations({
      description: "The COMPLETE plan, in order — this replaces any previous plan.",
    }),
  },
  success: Schema.Struct({
    total: Schema.Number,
    done: Schema.Number,
  }),
  failure: Failure,
  failureMode: "return",
})

export const codingToolkit = Toolkit.make(
  ReadFile,
  WriteFile,
  EditFile,
  Bash,
  Grep,
  Glob,
  Ls,
  ReadSkill,
  ReadMemory,
  Remember,
  WebFetch,
  WebSearchTool,
  UpdatePlan,
)

/**
 * Binds the coding handlers to a scope. For the **root** scope
 * `rootDir === displayRoot ===` the workspace and `enforceWrite` is false,
 * so behaviour is identical to a plain workspace-wide agent. For a **child**
 * scope, `rootDir` is the scope dir (writes + bash confined there) while
 * `displayRoot` stays the workspace root (reads/grep/glob/ls range over the
 * whole tree and paths render workspace-relative).
 */
export interface ScopeBinding {
  /** Absolute path; writes + bash are confined here when `enforceWrite`. */
  readonly rootDir: string
  /** Absolute anchor for path resolution + relative display (workspace root). */
  readonly displayRoot: string
  /** Reject `write_file`/`edit_file` outside `rootDir`. False for the root. */
  readonly enforceWrite: boolean
  /** Allow the `bash` tool. */
  readonly allowBash: boolean
}

/**
 * Build the coding-tool handler record for a scope, resolving
 * `FileSystem`/`Shell`/`Http` from context once at build time. Shared by
 * `codingToolkitLayer` (root, back-compat) and `buildScopeRuntime` (which
 * adds the `run_agent` handler). Each returned handler is an
 * `R = never` Effect (it closes over the resolved services).
 */
export const makeCodingHandlers = (
  binding: ScopeBinding,
  skills: ReadonlyArray<Skill> = [],
  memory: ReadonlyArray<Memory> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const shell = yield* Shell
    const http = yield* Http
    const webSearch = yield* WebSearchPort
    const approval = yield* Approval
    const { rootDir, displayRoot, enforceWrite, allowBash } = binding
    const skillByName = new Map(skills.map((s) => [s.name, s] as const))
    const memoryByName = new Map(memory.map((m) => [m.name, m] as const))

    const rejectIfOutOfScope = (abs: string) =>
      enforceWrite && !isWithinScope(abs, rootDir)
        ? Effect.fail({
            error: "OutOfScope",
            message: `${displayPath(displayRoot, abs)} is outside this scope (${displayPath(displayRoot, rootDir)}). Defer it to the parent in your summary.`,
          })
        : Effect.void

    // A turn's tool calls resolve CONCURRENTLY (agentLoop's `concurrency`), so
    // mutating tools must not interleave: two edit_file calls on the same file
    // are a read-modify-write race that silently loses one edit, and bash can
    // race an edit it depends on. Reads + web stay parallel (the win); writes
    // and shell serialize on this one-permit gate per handler set. Bash holds
    // it only around the exec — never while waiting on the approval modal.
    const writeGate = Effect.unsafeMakeSemaphore(1)

    return codingToolkit.of({
      read_file: ({ path, offset, limit }) =>
        Effect.gen(function* () {
          const abs = resolvePath(displayRoot, path)
          const result = yield* fs.read(abs, {
            ...(offset !== undefined ? { offset } : {}),
            ...(limit !== undefined ? { limit } : {}),
          })
          return {
            path: displayPath(displayRoot, abs),
            content: formatReadOutput(
              result.content,
              offset ?? 1,
              result.truncated,
              result.totalLines,
            ),
            totalLines: result.totalLines,
            truncated: result.truncated,
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      write_file: ({ path, content }) =>
        writeGate.withPermits(1)(Effect.gen(function* () {
          const abs = resolvePath(displayRoot, path)
          yield* rejectIfOutOfScope(abs)
          // Prior content (empty for a brand-new file) → an old→new unified diff,
          // so write_file reads like edit_file in the rail (a new file shows as
          // all-additions). A missing file fails the read; default to "".
          const before = yield* fs
            .read(abs)
            .pipe(Effect.map((r) => r.content), Effect.orElseSucceed(() => ""))
          yield* fs.write(abs, content)
          return {
            path: displayPath(displayRoot, abs),
            bytes: new TextEncoder().encode(content).byteLength,
            lines: content === "" ? 0 : content.replace(/\n$/, "").split("\n").length,
            diff: unifiedDiff(before, content, displayPath(displayRoot, abs)),
          }
        })).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      edit_file: ({ path, edits, oldText, newText }) =>
        writeGate.withPermits(1)(Effect.gen(function* () {
          const normalized = normalizeEdits({ edits, oldText, newText })
          if (normalized.length === 0) {
            return yield* Effect.fail({
              error: "EditFailed",
              message:
                "no edits provided — pass edits: [{ oldText, newText }] (or the single-edit oldText/newText fields)",
            })
          }
          const abs = resolvePath(displayRoot, path)
          yield* rejectIfOutOfScope(abs)
          const before = yield* fs.read(abs)
          const applied = applyEditsToContent(before.content, normalized)
          if (applied.error !== undefined) {
            return yield* Effect.fail({
              error: "EditFailed",
              message: applied.error,
            })
          }
          yield* fs.write(abs, applied.result)
          return {
            path: displayPath(displayRoot, abs),
            editsApplied: normalized.length,
            diff: unifiedDiff(
              before.content,
              applied.result,
              displayPath(displayRoot, abs),
            ),
          }
        })).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      Bash: ({ command, timeout }) =>
        Effect.gen(function* () {
          if (!allowBash) {
            return yield* Effect.fail({
              error: "BashNotAllowed",
              message:
                "bash execution is disabled in this mode — re-run with --allow-bash to enable",
            })
          }
          // Human approval (interactive modes prompt; headless is allow-all
          // behind the --allow-bash gate above). A denial is data: the model
          // reads the reason and adjusts inside the same turn.
          const decision = yield* approval.request({
            tool: "Bash",
            summary: command,
            cwd: rootDir,
            ruleKey: bashRuleKey(command),
          })
          if (decision.kind === "deny") {
            return yield* Effect.fail({
              error: "Denied",
              message:
                decision.reason !== undefined && decision.reason.trim().length > 0
                  ? `the user denied this command: ${decision.reason.trim()} — adjust your approach; don't retry it verbatim.`
                  : "the user denied this command. Don't retry it verbatim — adjust your approach or ask what they'd prefer.",
            })
          }
          const r = yield* writeGate.withPermits(1)(
            shell.exec({
              command,
              cwd: rootDir,
              timeoutMs: timeout ?? 60_000,
            }),
          )
          return {
            exitCode: r.exitCode ?? -1,
            stdout: truncateOutput(r.stdout, 32_000),
            stderr: truncateOutput(r.stderr, 8_000),
            durationMs: r.durationMs,
            timedOut: r.timedOut,
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      grep: ({ pattern, dir, flags, context }) =>
        Effect.gen(function* () {
          const target = dir !== undefined ? resolvePath(displayRoot, dir) : displayRoot
          // `context` is a schema-validated Number; floor it for a clean integer.
          const ctxFlag = context !== undefined ? ` -C ${Math.max(0, Math.trunc(context))}` : ""
          // `flags` is interpolated UNQUOTED into a `bash -c` grep command, so it
          // must not carry shell metacharacters. `parseGrepFlags` allows only bare
          // grep flags and rejects anything else (`; rm`, `$(…)`, `--include=*`) as
          // a model-visible failure instead of executing it — closing a command-
          // injection vector that also bypassed the bash gate.
          const parsedFlags = parseGrepFlags(flags)
          if (!parsedFlags.ok) {
            return yield* Effect.fail({
              error: "InvalidFlags",
              message: `grep flag ${JSON.stringify(
                parsedFlags.bad,
              )} is not allowed — pass only bare grep flags (letters/hyphens, e.g. -i, -iw, --ignore-case); no '=value' forms or shell characters.`,
            })
          }
          const extra = parsedFlags.extra
          const escaped = pattern.replace(/'/g, "'\\''")
          const cmd = `grep -rnE${ctxFlag}${extra} --exclude-dir=.git --exclude-dir=node_modules '${escaped}' ${JSON.stringify(target)} || true`
          const r = yield* shell.exec({ command: cmd, cwd: displayRoot, timeoutMs: 30_000 })
          return {
            dir: displayPath(displayRoot, target),
            pattern,
            output: truncateOutput(r.stdout, 32_000),
            exitCode: r.exitCode ?? -1,
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      glob: ({ pattern, dir }) =>
        Effect.gen(function* () {
          const target = dir !== undefined ? resolvePath(displayRoot, dir) : displayRoot
          const matches = yield* fs.glob(pattern, {
            cwd: target,
            respectGitignore: true,
          })
          return {
            dir: displayPath(displayRoot, target),
            pattern,
            matches: matches.slice(0, 200),
            truncated: matches.length > 200,
            total: matches.length,
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      ls: ({ path, recursive }) =>
        Effect.gen(function* () {
          const target = path !== undefined ? resolvePath(displayRoot, path) : displayRoot
          const entries = yield* fs.list(target, {
            ...(recursive !== undefined ? { recursive } : {}),
          })
          return {
            path: displayPath(displayRoot, target),
            entries: entries.slice(0, 500).map((e) => ({
              path: displayPath(displayRoot, e.path),
              type: e.type,
            })),
            truncated: entries.length > 500,
            total: entries.length,
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      web_fetch: ({ url, maxBytes }) =>
        Effect.gen(function* () {
          if (!/^https?:\/\//i.test(url)) {
            return yield* Effect.fail({
              error: "InvalidUrl",
              message: "url must be an absolute http:// or https:// URL",
            })
          }
          const cap = maxBytes ?? 50_000
          const res = yield* http.get(url, { maxBytes: cap })
          const text = res.contentType.includes("html")
            ? htmlToText(res.body)
            : res.body
          return {
            url,
            status: res.status,
            contentType: res.contentType,
            content: truncateOutput(text, cap),
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      search_web: ({ query }) =>
        webSearch.search(query).pipe(
          Effect.map((r) => ({ answer: r.answer, sources: r.sources })),
          Effect.catchAll((e) => Effect.fail(toFailure(e))),
        ),

      read_skill: ({ name }) =>
        Effect.gen(function* () {
          const skill = skillByName.get(name)
          if (skill === undefined) {
            return yield* Effect.fail({
              error: "UnknownSkill",
              message: `No skill named '${name}'. Available: ${
                [...skillByName.keys()].join(", ") || "(none)"
              }`,
            })
          }
          const read = yield* fs.read(skill.sourcePath)
          return {
            name: skill.name,
            sourcePath: skill.sourcePath,
            body: stripFrontmatter(read.content),
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      read_memory: ({ name }) =>
        Effect.gen(function* () {
          const record = memoryByName.get(name)
          if (record === undefined) {
            return yield* Effect.fail({
              error: "UnknownMemory",
              message: `No memory named '${name}'. Available: ${
                [...memoryByName.keys()].join(", ") || "(none)"
              }`,
            })
          }
          const read = yield* fs.read(record.sourcePath)
          return {
            name: record.name,
            title: record.title,
            sourcePath: record.sourcePath,
            body: stripFrontmatter(read.content),
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      // Durable knowledge → `<workspace>/.efferent/memory/<slug>.md`. Anchored on
      // displayRoot (the workspace root) so the layer is shared across the root
      // and every sub-agent, regardless of scope. Append-not-clobber: an existing
      // record gains a timestamped ADR-style entry; a new one is created with
      // frontmatter (title + summary). Serialized on the write gate.
      remember: ({ title, content, name, summary }) =>
        writeGate.withPermits(1)(Effect.gen(function* () {
          const slug = slugify(
            name !== undefined && name.trim().length > 0 ? name : title,
          )
          const abs = resolve(displayRoot, ".efferent/memory", `${slug}.md`)
          const trimmedSummary =
            summary !== undefined && summary.trim().length > 0
              ? summary.trim()
              : firstLine(content)
          const stamp = new Date().toISOString()
          const exists = yield* fs.exists(abs)
          if (exists) {
            const before = yield* fs.read(abs)
            const entry = `\n## ${stamp} — ${title}\n\n${content.trim()}\n`
            yield* fs.write(abs, `${before.content.replace(/\n+$/, "")}\n${entry}`)
          } else {
            const doc =
              `---\ntitle: ${title}\nsummary: ${trimmedSummary}\n---\n\n` +
              `# ${title}\n\n## ${stamp}\n\n${content.trim()}\n`
            yield* fs.write(abs, doc)
          }
          return {
            name: slug,
            path: displayPath(displayRoot, abs),
            created: !exists,
          }
        })).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      // Pure echo: the plan IS the call's arguments — the UI reads them off
      // the event stream / persisted history; nothing to store here.
      update_plan: ({ steps }) =>
        steps.length === 0
          ? Effect.fail({
              error: "EmptyPlan",
              message: "Send the complete plan — at least one step.",
            })
          : Effect.succeed({
              total: steps.length,
              done: steps.filter((s) => s.status === "done").length,
            }),
    })
  })

/**
 * Handler Layer for the coding toolkit, bound to a workspace `cwd` and the
 * discovered `skills` — the root scope's flavour (writes unrestricted, paths
 * anchored on `cwd`). Requires `FileSystem | Shell | Http`, satisfied at the
 * driver's composition root. `buildScopeRuntime` builds richer per-scope
 * layers on top of `makeCodingHandlers`.
 */
export const codingToolkitLayer = (
  cwd: string,
  skills: ReadonlyArray<Skill> = [],
  options: { readonly allowBash?: boolean; readonly memory?: ReadonlyArray<Memory> } = {},
) =>
  codingToolkit.toLayer(
    makeCodingHandlers(
      {
        rootDir: cwd,
        displayRoot: cwd,
        enforceWrite: false,
        allowBash: options.allowBash ?? true,
      },
      skills,
      options.memory ?? [],
    ),
  )
