import { Effect, Option, Schema } from "effect"
import { readdir, readFile, rename, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"
import * as readline from "node:readline"
import { XPlatform } from "../ports/XPlatform.js"
import { BlogReader } from "../ports/BlogReader.js"
import { appendLedger, LedgerEntry, readLedger } from "../domain/Ledger.js"
import { loadPolicy } from "../domain/policy.js"
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
class ReviewError extends Schema.TaggedError<ReviewError>()("ReviewError", {
  message: Schema.String,
}) {}

interface DraftMetadata {
  readonly type: "reply" | "post"
  readonly targetTweetId: Option.Option<string>
  readonly targetAuthor: Option.Option<string>
  readonly referenceBlogSlug: Option.Option<string>
  readonly status: string
  readonly content: string
  readonly filePath: string
  readonly filename: string
}

/** `Option → { key: value }` for the optional-field spreads below. */
const optField = <K extends string, A>(key: K, value: Option.Option<A>) =>
  Option.match(value, { onNone: () => ({}), onSome: (a) => ({ [key]: a }) })

const parseDraftFile = async (filename: string): Promise<DraftMetadata> => {
  const filePath = join(PENDING_DIR, filename)
  const fileContent = await readFile(filePath, "utf-8")
  
  const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const body = match ? fileContent.slice(match[0].length).trim() : fileContent.trim()

  const defaults = {
    type: "post" as "reply" | "post",
    targetTweetId: Option.none<string>(),
    targetAuthor: Option.none<string>(),
    referenceBlogSlug: Option.none<string>(),
    status: "pending",
  }
  const folded = (match?.[1] ?? "").split("\n").reduce<typeof defaults>(
    (acc, line) => {
      const colonIndex = line.indexOf(":")
      if (colonIndex === -1) return acc
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim().replace(/^['"]|['"]$/g, "")
      if (key === "type" && (value === "reply" || value === "post")) return { ...acc, type: value }
      if (key === "targetTweetId" && value !== "null") return { ...acc, targetTweetId: Option.some(value) }
      if (key === "targetAuthor" && value !== "null") return { ...acc, targetAuthor: Option.some(value) }
      if (key === "referenceBlogSlug" && value !== "null") return { ...acc, referenceBlogSlug: Option.some(value) }
      if (key === "status") return { ...acc, status: value }
      return acc
    },
    defaults,
  )

  return { ...folded, content: body, filePath, filename }
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
  draft: Pick<DraftMetadata, "type" | "content" | "targetTweetId" | "targetAuthor" | "referenceBlogSlug">,
  args: {
    readonly ledgerPath?: string
    readonly policyPath?: string
    readonly knownSlugs: ReadonlySet<string>
    readonly now?: Date
  },
): Effect.Effect<ReadonlyArray<SocialFinding>> =>
  Effect.gen(function* () {
    const ledger = yield* readLedger(args.ledgerPath ?? LEDGER_PATH)
    const policy = yield* loadPolicy(args.policyPath ?? POLICY_PATH)
    return runSocialGates(
      {
        kind: draft.type,
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
  event: "posted" | "discarded" | "skipped",
): LedgerEntry =>
  new LedgerEntry({
    at: new Date().toISOString(),
    event,
    kind: draft.type,
    ...optField("targetTweetId", draft.targetTweetId),
    ...optField("targetAuthor", draft.targetAuthor),
    ...optField("referenceBlogSlug", draft.referenceBlogSlug),
    content: draft.content,
    filename: draft.filename,
  })

export const runReviewQueue = () =>
  Effect.gen(function* () {
    const x = yield* XPlatform
    const blog = yield* BlogReader
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
    const reviewOne = (file: string): Effect.Effect<"continue" | "quit", ReviewError, never> =>
      Effect.gen(function* () {
        const draft = yield* Effect.tryPromise({
          try: () => parseDraftFile(file),
          catch: (e) => new ReviewError({ message: `Failed to parse draft "${file}": ${String(e)}` }),
        })

        console.log("==================================================")
        console.log(`DRAFT: ${draft.filename}`)
        console.log(`Type:  ${draft.type.toUpperCase()}`)
        if (draft.type === "reply") {
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
          yield* appendLedger(LEDGER_PATH, ledgerRow(draft, "skipped")).pipe(Effect.ignore)
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
          yield* appendLedger(LEDGER_PATH, ledgerRow(draft, "discarded")).pipe(Effect.ignore)
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
          // ---- Gate B: nothing leaves for X unvalidated (the [e]dit path
          // used to post >280 raw; caps/dedup are re-checked AT SEND). ----
          const findings = yield* gateBeforePost(draft, { knownSlugs })
          if (findings.length > 0) {
            console.log("⛔ Gate B blocked this draft:")
            console.log(renderFindings(findings))
            console.log("Edit it ([e]) or discard it ([d]).\n")
            return yield* reviewOne(file)
          }
          console.log("Posting to X...")
          yield* x.postTweet(draft.content, Option.getOrUndefined(draft.targetTweetId)).pipe(
            Effect.tap(() =>
              Effect.tryPromise({
                try: async () => {
                  await mkdir(POSTED_DIR, { recursive: true })
                  await rename(draft.filePath, join(POSTED_DIR, draft.filename))
                },
                catch: (e) => new ReviewError({ message: `Failed to archive posted draft: ${String(e)}` }),
              })
            ),
            Effect.tap(() => appendLedger(LEDGER_PATH, ledgerRow(draft, "posted")).pipe(Effect.ignore)),
            Effect.tap(() => Effect.sync(() => console.log("✅ Successfully posted to X!\n"))),
            Effect.catchAll((err) =>
              Effect.sync(() => console.error(`❌ Posting failed: ${err.message}\n`))
            )
          )
          return "continue" as const
        }

        // Unrecognized input — ask again.
        return yield* reviewOne(file)
      })

    yield* Effect.reduce(pendingDrafts, "continue" as "continue" | "quit", (state, file) =>
      state === "quit" ? Effect.succeed(state) : reviewOne(file),
    )

    console.log("Finished reviewing all pending drafts.")
  })
