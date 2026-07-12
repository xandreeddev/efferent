import { Tool, Toolkit } from "@effect/ai"
import { Effect, Ref, Schema } from "effect"
import { Failure } from "@xandreed/engine"
import { XPlatform } from "../ports/x-platform.port.js"
import { BlogReader } from "../ports/blog-reader.port.js"
import type { LedgerEntry } from "../domain/ledger.entity.js"
import { SocialWorkspace } from "../ports/social-workspace.port.js"
import {
  renderFindings,
  runSocialGates,
  type SocialDraft,
} from "../domain/gates.js"
import { DRAFTS_PENDING_DIR, LEDGER_PATH, POLICY_PATH } from "../domain/paths.js"
import type { XSearchResult } from "../ports/x-platform.port.js"

// ---- Tool Definitions ----

export const SearchX = Tool.make("search_x", {
  description: "Search X (Twitter) for recent technical discussions or developer queries.",
  parameters: {
    query: Schema.String.annotations({
      description: "Search query, e.g., 'EffectTS' or 'typescript agent concurrency'.",
    }),
  },
  success: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        author: Schema.String,
        text: Schema.String,
        timestamp: Schema.String,
      })
    ),
  }),
  failure: Failure,
  failureMode: "return",
})

export const GetXNotifications = Tool.make("get_x_notifications", {
  description: "Retrieve recent mentions, replies, or direct notifications on your account.",
  parameters: {
    limit: Schema.optional(
      Schema.Number.annotations({ description: "Maximum number of notifications to return. Defaults to 10." })
    ),
  },
  success: Schema.Struct({
    notifications: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        author: Schema.String,
        text: Schema.String,
      })
    ),
  }),
  failure: Failure,
  failureMode: "return",
})

export const ReadThread = Tool.make("read_thread", {
  description:
    "Read a tweet and its visible conversation context BEFORE drafting a reply. Required: a reply that hasn't read its thread is rejected by the thread-context gate.",
  parameters: {
    tweetId: Schema.String.annotations({
      description: "The status ID of the tweet to read in context.",
    }),
  },
  success: Schema.Struct({
    thread: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        author: Schema.String,
        text: Schema.String,
        timestamp: Schema.String,
      })
    ),
  }),
  failure: Failure,
  failureMode: "return",
})

export const ReadBlogPosts = Tool.make("read_blog_posts", {
  description: "Retrieve summaries (slug, title, description, tags) of your published blog posts.",
  parameters: {
    limit: Schema.optional(
      Schema.Number.annotations({ description: "Maximum posts to return." })
    ),
  },
  success: Schema.Struct({
    posts: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        title: Schema.String,
        description: Schema.String,
        tags: Schema.Array(Schema.String),
      })
    ),
  }),
  failure: Failure,
  failureMode: "return",
})

export const ReadBlogPostContent = Tool.make("read_blog_post_content", {
  description: "Read the full markdown body content of a specific blog post by its slug.",
  parameters: {
    slug: Schema.String.annotations({
      description: "Slug of the blog post (e.g. 'effect-for-ai').",
    }),
  },
  success: Schema.Struct({
    slug: Schema.String,
    content: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

export const WriteDraft = Tool.make("write_draft", {
  description:
    "Save a synthesized tweet or thread reply as a draft in the human review queue. The draft passes the DETERMINISTIC POLICY GATES first (dedup, caps, banned content, length, links, thread-context…) — a rejection returns every finding; fix exactly what the findings say or drop the candidate. For a reply, call read_thread first.",
  parameters: {
    type: Schema.Literal("reply", "post").annotations({
      description: "Whether this is a reply to an existing tweet or a standalone post.",
    }),
    content: Schema.String.annotations({
      description: "The draft post/reply content (under 280 characters; links count as 23).",
    }),
    targetTweetId: Schema.optional(
      Schema.String.annotations({ description: "For replies, the status ID we are replying to." })
    ),
    targetAuthor: Schema.optional(
      Schema.String.annotations({ description: "For replies, the author of the target tweet (e.g. '@dan_abramov')." })
    ),
    referenceBlogSlug: Schema.optional(
      Schema.String.annotations({ description: "Slug of the blog post this reply/post aims to drive traffic to." })
    ),
  },
  success: Schema.Struct({
    path: Schema.String,
    filename: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

// ---- Toolkit Assembly ----

export const socialToolkit = Toolkit.make(
  SearchX,
  GetXNotifications,
  ReadThread,
  ReadBlogPosts,
  ReadBlogPostContent,
  WriteDraft
)

export type SocialToolkit = typeof socialToolkit

// ---- Handler Implementations ----

const toFailure = (e: unknown): Failure => ({
  error: e instanceof Error ? e.name : "Error",
  message: e instanceof Error ? e.message : String(e),
})

export interface SocialHandlerOptions {
  readonly pendingDir?: string
  readonly ledgerPath?: string
  readonly policyPath?: string
  readonly now?: () => Date
}

/**
 * One handler record per session. `read_thread` results are CACHED in a Ref —
 * that cache IS the trajectory evidence the thread-context gate checks: a
 * reply whose target thread isn't in it was drafted blind and is rejected.
 */
export const makeSocialHandlers = (options: SocialHandlerOptions = {}) =>
  Effect.gen(function* () {
    const x = yield* XPlatform
    const blog = yield* BlogReader
    const workspace = yield* SocialWorkspace
    const pendingDir = options.pendingDir ?? DRAFTS_PENDING_DIR
    const ledgerPath = options.ledgerPath ?? LEDGER_PATH
    const policyPath = options.policyPath ?? POLICY_PATH
    const now = options.now ?? (() => new Date())
    const threadsRead = yield* Ref.make(
      new Map<string, ReadonlyArray<XSearchResult>>(),
    )

    return socialToolkit.of({
      search_x: ({ query }) =>
        Effect.gen(function* () {
          const results = yield* x.search(query)
          return { results }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      get_x_notifications: ({ limit }) =>
        Effect.gen(function* () {
          const notifications = yield* x.getNotifications()
          const max = limit ?? 10
          return { notifications: notifications.slice(0, max) }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      read_thread: ({ tweetId }) =>
        Effect.gen(function* () {
          const thread = yield* x.readThread(tweetId)
          yield* Ref.update(threadsRead, (m) => new Map(m).set(tweetId, thread))
          return { thread }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      read_blog_posts: ({ limit }) =>
        Effect.gen(function* () {
          const allPosts = yield* blog.getPosts()
          const max = limit ?? allPosts.length
          const posts = allPosts.slice(0, max).map((p) => ({
            slug: p.slug,
            title: p.title,
            description: p.description,
            tags: p.tags,
          }))
          return { posts }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      read_blog_post_content: ({ slug }) =>
        Effect.gen(function* () {
          const content = yield* blog.getPostContent(slug)
          return { slug, content }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      write_draft: ({ type, content, targetTweetId, targetAuthor, referenceBlogSlug }) =>
        Effect.gen(function* () {
          // ---- Gate A: nothing enters the queue unvalidated ----
          const draft: SocialDraft = {
            kind: type,
            content: content.trim(),
            ...(targetTweetId !== undefined ? { targetTweetId } : {}),
            ...(targetAuthor !== undefined ? { targetAuthor } : {}),
            ...(referenceBlogSlug !== undefined ? { referenceBlogSlug } : {}),
          }
          const ledger = yield* workspace.readLedger(ledgerPath)
          const policy = yield* workspace.loadPolicy(policyPath)
          const posts = yield* blog
            .getPosts()
            .pipe(Effect.orElseSucceed(() => []))
          const threads = yield* Ref.get(threadsRead)
          const thread =
            targetTweetId !== undefined ? threads.get(targetTweetId) : undefined
          const findings = runSocialGates(draft, {
            now: now(),
            ledger,
            policy,
            ...(thread !== undefined ? { thread } : {}),
            knownSlugs: new Set(posts.map((p) => p.slug)),
            phase: "draft",
          })
          if (findings.length > 0) {
            const rejected: LedgerEntry = {
              at: now().toISOString(),
              event: "gate_rejected",
              kind: type,
              ...(targetTweetId !== undefined ? { targetTweetId } : {}),
              ...(targetAuthor !== undefined ? { targetAuthor } : {}),
              ...(referenceBlogSlug !== undefined ? { referenceBlogSlug } : {}),
              content: draft.content,
              findings: findings.map((finding) => `[${finding.rule}] ${finding.detail}`),
            }
            yield* workspace.appendLedger(
              ledgerPath,
              rejected,
            ).pipe(Effect.ignore)
            return yield* Effect.fail({
              error: "GateRejected",
              message: `the draft failed ${findings.length} policy gate(s):\n${renderFindings(findings)}`,
            })
          }

          const id = targetTweetId ?? `new_${now().getTime()}`
          const filename = `${type}_${id}.md`
          const filePath = `${pendingDir}/${filename}`
          const fmParts = [
            `type: "${type}"`,
            `targetTweetId: ${targetTweetId ? `"${targetTweetId}"` : "null"}`,
            `targetAuthor: ${targetAuthor ? `"${targetAuthor}"` : "null"}`,
            `referenceBlogSlug: ${referenceBlogSlug ? `"${referenceBlogSlug}"` : "null"}`,
            `status: "pending"`,
            `created_at: "${now().toISOString()}"`,
          ]
          const rawContent = `---\n${fmParts.join("\n")}\n---\n\n${draft.content}\n`
          yield* workspace.writeDraft(filePath, rawContent).pipe(Effect.mapError(toFailure))
          const drafted: LedgerEntry = {
            at: now().toISOString(),
            event: "drafted",
            kind: type,
            ...(targetTweetId !== undefined ? { targetTweetId } : {}),
            ...(targetAuthor !== undefined ? { targetAuthor } : {}),
            ...(referenceBlogSlug !== undefined ? { referenceBlogSlug } : {}),
            content: draft.content,
            filename,
          }
          yield* workspace.appendLedger(
            ledgerPath,
            drafted,
          ).pipe(Effect.ignore)
          return { path: filePath, filename }
        }),
    })
  })

export const SocialToolkitLive = socialToolkit.toLayer(makeSocialHandlers())
