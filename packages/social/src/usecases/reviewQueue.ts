import { Effect, Result, Match, Option, Schema } from "effect"
import { readdir, readFile, rename, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"
import * as readline from "node:readline"
import { XPlatform } from "../ports/x-platform.port.js"
import { BlogReader } from "../ports/blog-reader.port.js"
import type { LedgerEntry } from "../domain/ledger.entity.js"
import { SocialWorkspace } from "../ports/social-workspace.port.js"
import { renderFindings, runSocialGates, type SocialFinding } from "../domain/gates.js"
import {
  DRAFTS_DISCARDED_DIR,
  DRAFTS_PENDING_DIR,
  DRAFTS_POSTED_DIR,
  LEDGER_PATH,
  POLICY_PATH,
} from "../domain/paths.js"

const PENDING_DIR = DRAFTS_PENDING_DIR
const POSTED_DIR = DRAFTS_POSTED_DIR
const DISCARDED_DIR = DRAFTS_DISCARDED_DIR

/** Queue plumbing failures (fs, parse) — typed like every other error in
 *  the tree; raw `new Error` was the discipline outlier (audit). */
export class ReviewError extends Schema.TaggedError<ReviewError>()("ReviewError", {
  message: Schema.String,
}) {}

export type DraftKind = "reply" | "post"

export interface DraftMetadata {
  /** `None` = the frontmatter carries no `type:` — the draft is UNLABELED
   *  and never leaves. (A mangled [e]dit used to default to a top-level
   *  post with no target, past the dedup and author gates.) */
  readonly type: Option.Option<DraftKind>
  readonly targetTweetId: Option.Option<string>
  readonly targetAuthor: Option.Option<string>
  readonly referenceBlogSlug: Option.Option<string>
  readonly content: string
  readonly filePath: string
  readonly filename: string
}

/** `Option → { key: value }` for the optional-field spreads below. */
const optField = <K extends string, A>(key: K, value: Option.Option<A>) =>
  Option.match(value, { onNone: () => ({}), onSome: (a) => ({ [key]: a }) })

/** The draft file's frontmatter + body — pure, so the parser is tested
 *  without a queue directory. */
export const parseDraft = (fileContent: string, filePath: string, filename: string): DraftMetadata => {
  const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const body = match ? fileContent.slice(match[0].length).trim() : fileContent.trim()

  const defaults = {
    type: Option.none<DraftKind>(),
    targetTweetId: Option.none<string>(),
    targetAuthor: Option.none<string>(),
    referenceBlogSlug: Option.none<string>(),
  }
  const folded = (match?.[1] ?? "").split("\n").reduce<typeof defaults>(
    (acc, line) => {
      const colonIndex = line.indexOf(":")
      if (colonIndex === -1) return acc
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim().replace(/^['"]|['"]$/g, "")
      if (key === "type" && (value === "reply" || value === "post")) return { ...acc, type: Option.some(value) }
      if (key === "targetTweetId" && value !== "null") return { ...acc, targetTweetId: Option.some(value) }
      if (key === "targetAuthor" && value !== "null") return { ...acc, targetAuthor: Option.some(value) }
      if (key === "referenceBlogSlug" && value !== "null") return { ...acc, referenceBlogSlug: Option.some(value) }
      return acc
    },
    defaults,
  )

  return { ...folded, content: body, filePath, filename }
}

const parseDraftFile = async (filename: string): Promise<DraftMetadata> => {
  const filePath = join(PENDING_DIR, filename)
  return parseDraft(await readFile(filePath, "utf-8"), filePath, filename)
}

const askQuestion = (query: string): Promise<string> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  )
}

const openEditor = (filePath: string): Promise<void> => {
  const editor = process.env.EDITOR || "nano"
  return new Promise((resolve) => {
    const child = spawn(editor, [filePath], { stdio: "inherit" })
    child.on("exit", () => resolve())
  })
}

/** Gate B — the pre-post check, run on the draft AS IT IS NOW (after any
 *  human [e]dit) plus the post-time ledger state (dedup vs posted, caps at
 *  send). Nothing leaves for X without passing it. */
export const gateBeforePost = (
  draft: Pick<DraftMetadata, "content" | "targetTweetId" | "targetAuthor" | "referenceBlogSlug"> & {
    readonly kind: DraftKind
  },
  args: {
    readonly ledgerPath?: string
    readonly policyPath?: string
    readonly knownSlugs: ReadonlySet<string>
    readonly now?: Date
  },
): Effect.Effect<ReadonlyArray<SocialFinding>, never, SocialWorkspace> =>
  Effect.gen(function* () {
    const workspace = yield* SocialWorkspace
    const ledger = yield* workspace.readLedger(args.ledgerPath ?? LEDGER_PATH)
    const policy = yield* workspace.loadPolicy(args.policyPath ?? POLICY_PATH)
    return runSocialGates(
      {
        kind: draft.kind,
        content: draft.content,
        ...optField("targetTweetId", draft.targetTweetId),
        ...optField("targetAuthor", draft.targetAuthor),
        ...optField("referenceBlogSlug", draft.referenceBlogSlug),
      },
      {
        now: args.now ?? new Date(),
        ledger,
        policy,
        knownSlugs: args.knownSlugs,
        phase: "post",
      },
    )
  })

const ledgerRow = (
  draft: DraftMetadata,
  kind: DraftKind,
  event: LedgerEntry["event"],
  findings?: ReadonlyArray<string>,
): LedgerEntry =>
  ({
    at: new Date().toISOString(),
    event,
    kind,
    ...optField("targetTweetId", draft.targetTweetId),
    ...optField("targetAuthor", draft.targetAuthor),
    ...optField("referenceBlogSlug", draft.referenceBlogSlug),
    content: draft.content,
    filename: draft.filename,
    ...(findings === undefined ? {} : { findings }),
  })

/** The kind a skip/discard row records for an unlabeled draft — those rows
 *  gate nothing, so the fallback is harmless. */
const kindOrPost = (draft: DraftMetadata): DraftKind => Option.getOrElse(draft.type, () => "post")

const archiveToPosted = (draft: DraftMetadata): Effect.Effect<void, ReviewError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(POSTED_DIR, { recursive: true })
      await rename(draft.filePath, join(POSTED_DIR, draft.filename))
    },
    catch: (e) => new ReviewError({ message: `Failed to archive posted draft: ${String(e)}` }),
  })

export type ApproveOutcome =
  | { readonly _tag: "unlabeled" }
  | { readonly _tag: "blocked"; readonly findings: ReadonlyArray<SocialFinding> }
  | { readonly _tag: "ledger-refused"; readonly message: string }
  | { readonly _tag: "post-failed"; readonly message: string }
  | { readonly _tag: "posted"; readonly archived: boolean }

/**
 * The APPROVE step. The order IS the double-post defence:
 * 1. Gate B over the draft as it is now.
 * 2. The `posting` INTENT on the ledger, fail-CLOSED — no row, no post.
 * 3. The platform call.
 * 4. `posted` (or `post_failed`) on the ledger; the archive move last,
 *    best-effort and loud.
 * Before: post → archive → ledger (ignored). An archive failure left the
 * tweet live, the draft pending, and the ledger blank — and a re-approval
 * sailed through dedup and posted it again under the alias.
 */
export const approveDraft = (
  draft: DraftMetadata,
  args: {
    readonly knownSlugs: ReadonlySet<string>
    readonly ledgerPath?: string
    readonly policyPath?: string
    readonly now?: Date
    /** The post-success move; the queue's default archives to posted/. */
    readonly archive?: (draft: DraftMetadata) => Effect.Effect<void, ReviewError>
  },
): Effect.Effect<ApproveOutcome, never, XPlatform | SocialWorkspace> =>
  Effect.gen(function* () {
    const x = yield* XPlatform
    const workspace = yield* SocialWorkspace
    if (Option.isNone(draft.type)) return { _tag: "unlabeled" } as const
    const kind = draft.type.value
    const findings = yield* gateBeforePost({ ...draft, kind }, args)
    if (findings.length > 0) return { _tag: "blocked", findings } as const
    const ledgerPath = args.ledgerPath ?? LEDGER_PATH

    const intent = yield* workspace
      .appendLedger(ledgerPath, ledgerRow(draft, kind, "posting"))
      .pipe(Effect.result)
    if (Result.isFailure(intent)) {
      return { _tag: "ledger-refused", message: intent.failure.message } as const
    }

    const sent = yield* x
      .postTweet(draft.content, Option.getOrUndefined(draft.targetTweetId))
      .pipe(Effect.result)
    if (Result.isFailure(sent)) {
      yield* workspace
        .appendLedger(ledgerPath, ledgerRow(draft, kind, "post_failed", [sent.failure.message]))
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`the ledger refused the post_failed row: ${error.message}`),
          ),
        )
      return { _tag: "post-failed", message: sent.failure.message } as const
    }

    yield* workspace.appendLedger(ledgerPath, ledgerRow(draft, kind, "posted")).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `POSTED, but the ledger refused the posted row (${error.message}) — the posting intent stands; add the row by hand`,
        ),
      ),
    )
    const archived = yield* (args.archive ?? archiveToPosted)(draft).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning(`posted, but archiving the draft failed: ${error.message}`).pipe(
          Effect.as(false),
        ),
      ),
    )
    return { _tag: "posted", archived } as const
  })

export const runReviewQueue = () =>
  Effect.gen(function* () {
    const blog = yield* BlogReader
    const workspace = yield* SocialWorkspace
    const knownSlugs = new Set(
      (yield* blog.getPosts().pipe(Effect.orElseSucceed(() => []))).map((p) => p.slug),
    )

    yield* Effect.logInfo("Loading pending drafts...")
    const files = yield* Effect.tryPromise({
      // An absent queue dir is an empty queue (two-arg then — no catch).
      try: () =>
        readdir(PENDING_DIR).then(
          (entries) => entries,
          () => [] as string[],
        ),
      catch: (e) => new ReviewError({ message: `Failed to list pending drafts: ${String(e)}` }),
    })

    const pendingDrafts = files.filter((f) => f.endsWith(".md"))

    if (pendingDrafts.length === 0) {
      console.log("\n🎉 No pending drafts in the review queue!")
      return
    }

    console.log(`\nFound ${pendingDrafts.length} drafts to review.\n`)

    // One draft at a time; each is a small recursive state machine
    // (show → ask → act; [e]dit loops back to a fresh re-parse) and "q" stops
    // the whole queue. Recursion replaces the old mutable while-flags.
    const reviewOne = (
      file: string,
    ): Effect.Effect<"continue" | "quit", ReviewError, XPlatform | SocialWorkspace> =>
      Effect.gen(function* () {
        const draft = yield* Effect.tryPromise({
          try: () => parseDraftFile(file),
          catch: (e) => new ReviewError({ message: `Failed to parse draft "${file}": ${String(e)}` }),
        })

        console.log("==================================================")
        console.log(`DRAFT: ${draft.filename}`)
        console.log(
          `Type:  ${Option.match(draft.type, {
            onNone: () => "UNLABELED — set `type: reply | post` in the frontmatter before approving",
            onSome: (kind) => kind.toUpperCase(),
          })}`,
        )
        if (Option.exists(draft.type, (kind) => kind === "reply")) {
          const author = Option.getOrElse(draft.targetAuthor, () => "(unknown)")
          const target = Option.getOrElse(draft.targetTweetId, () => "(missing id)")
          console.log(`Replying to: ${author} (ID: ${target})`)
          console.log(`Target URL:  https://x.com/anyuser/status/${target}`)
        }
        Option.match(draft.referenceBlogSlug, {
          onNone: () => {},
          onSome: (slug) => console.log(`Ref Blog:    https://xandreed.dev/posts/${slug}`),
        })
        console.log("--------------------------------------------------")
        console.log(draft.content)
        console.log("==================================================")

        const choice = yield* Effect.promise(() =>
          askQuestion("[a] Approve & Post, [e] Edit, [d] Discard, [s] Skip, [q] Quit: ")
        )

        if (choice === "q") {
          console.log("Exiting review queue.")
          return "quit" as const
        }

        if (choice === "s") {
          yield* workspace
            .appendLedger(LEDGER_PATH, ledgerRow(draft, kindOrPost(draft), "skipped"))
            .pipe(Effect.ignore)
          console.log("Skipping draft.\n")
          return "continue" as const
        }

        if (choice === "d") {
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(DISCARDED_DIR, { recursive: true })
              await rename(draft.filePath, join(DISCARDED_DIR, draft.filename))
            },
            catch: (e) => new ReviewError({ message: `Failed to discard draft: ${String(e)}` }),
          })
          yield* workspace
            .appendLedger(LEDGER_PATH, ledgerRow(draft, kindOrPost(draft), "discarded"))
            .pipe(Effect.ignore)
          console.log("Draft moved to discarded.\n")
          return "continue" as const
        }

        if (choice === "e") {
          console.log(`Opening editor (${process.env.EDITOR || "nano"})...`)
          yield* Effect.promise(() => openEditor(draft.filePath))
          console.log("Reloading updated draft...\n")
          return yield* reviewOne(file)
        }

        if (choice === "a") {
          console.log("Posting to X...")
          const outcome = yield* approveDraft(draft, { knownSlugs })
          return yield* Match.value(outcome).pipe(
            Match.tag("unlabeled", () =>
              Effect.sync(() => {
                console.log(
                  "⛔ This draft has no `type:` in its frontmatter — nothing leaves unlabeled. Edit it ([e]) and set type: reply | post.\n",
                )
              }).pipe(Effect.andThen(reviewOne(file))),
            ),
            Match.tag("blocked", (blocked) =>
              Effect.sync(() => {
                console.log("⛔ Gate B blocked this draft:")
                console.log(renderFindings(blocked.findings))
                console.log("Edit it ([e]) or discard it ([d]).\n")
              }).pipe(Effect.andThen(reviewOne(file))),
            ),
            Match.tag("ledger-refused", (refused) =>
              Effect.sync(() => {
                console.error(
                  `❌ Not posting: the ledger refused the posting row (${refused.message}). Fix the ledger first — nothing leaves without its row.\n`,
                )
              }).pipe(Effect.as("continue" as const)),
            ),
            Match.tag("post-failed", (failed) =>
              Effect.sync(() => {
                console.error(
                  `❌ Posting failed: ${failed.message}\n   The draft stays pending; the ledger records the failed attempt.\n`,
                )
              }).pipe(Effect.as("continue" as const)),
            ),
            Match.tag("posted", (posted) =>
              Effect.sync(() => {
                console.log(
                  posted.archived
                    ? "✅ Successfully posted to X!\n"
                    : "✅ Posted to X — but the draft could not be moved to posted/; move it by hand so it is not reviewed again.\n",
                )
              }).pipe(Effect.as("continue" as const)),
            ),
            Match.exhaustive,
          )
        }

        // Unrecognized input — ask again.
        return yield* reviewOne(file)
      })

    yield* Effect.reduce(pendingDrafts, (): "continue" | "quit" => "continue", (state, file) =>
      state === "quit" ? Effect.succeed(state) : reviewOne(file),
    )

    console.log("Finished reviewing all pending drafts.")
  })
