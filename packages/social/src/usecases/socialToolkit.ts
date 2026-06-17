import { Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Schema } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Failure } from "@efferent/sdk-core"
import { XPlatform } from "../ports/XPlatform.js"
import { BlogReader } from "../ports/BlogReader.js"

const DRAFTS_DIR = "/home/asiborro/Workspace/xandreed/posts/drafts"

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
  description: "Save a synthesized tweet or thread reply as a local markdown draft file in the review queue.",
  parameters: {
    type: Schema.Literal("reply", "post").annotations({
      description: "Whether this is a reply to an existing tweet or a standalone post.",
    }),
    content: Schema.String.annotations({
      description: "The draft post/reply content (under 280 characters).",
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

export const makeSocialHandlers = () =>
  Effect.gen(function* () {
    const x = yield* XPlatform
    const blog = yield* BlogReader

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
        Effect.tryPromise({
          try: async () => {
            const id = targetTweetId ?? `new_${Date.now()}`
            const filename = `${type}_${id}.md`
            const subDir = join(DRAFTS_DIR, "pending")
            const filePath = join(subDir, filename)
            
            // Generate markdown file with YAML frontmatter
            const fmParts = [
              `type: "${type}"`,
              `targetTweetId: ${targetTweetId ? `"${targetTweetId}"` : "null"}`,
              `targetAuthor: ${targetAuthor ? `"${targetAuthor}"` : "null"}`,
              `referenceBlogSlug: ${referenceBlogSlug ? `"${referenceBlogSlug}"` : "null"}`,
              `status: "pending"`,
              `created_at: "${new Date().toISOString()}"`,
            ]
            const rawContent = `---\n${fmParts.join("\n")}\n---\n\n${content.trim()}\n`
            
            await mkdir(subDir, { recursive: true })
            await writeFile(filePath, rawContent, "utf-8")
            
            return {
              path: filePath,
              filename,
            }
          },
          catch: (e) => toFailure(e),
        }),
    })
  })

export const SocialToolkitLive = socialToolkit.toLayer(makeSocialHandlers())
