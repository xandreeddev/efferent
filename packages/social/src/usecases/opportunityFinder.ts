import { Effect } from "effect"
import { LanguageModel, Toolkit } from "@effect/ai"
import { runAgentLoop, type AgentMessage } from "@xandreed/sdk-core"
import { readdir } from "node:fs/promises"
import { BlogReader } from "../ports/BlogReader.js"
import { XPlatform, type XSearchResult } from "../ports/XPlatform.js"
import { socialToolkit, SocialToolkitLive } from "./socialToolkit.js"
import type { Failure } from "@xandreed/sdk-core"

const DRAFTS_DIR = "/home/user/Workspace/xandreed/posts/drafts/pending"

const SYSTEM_PROMPT = `You are the automated social research agent for Xand Reed (@xandreeddev).
Your purpose is to find discussions on X (Twitter) where you can add genuine technical value, reply to queries, and drive traffic to your Astro blog (xandreed.dev) about building agents using Effect.ts.

You have access to tools to search X, get notifications, list your blog posts, read their content, and write drafts to your local review queue.

IMPORTANT STRATEGY:
1. DO NOT SPAM. Only reply when you can offer a concrete, technically precise answer.
2. Align with Xand Reed's identity: developer-centric, receipt-driven, zero hype, direct, using Effect.ts.
3. If a tweet is a good fit, find the most relevant blog post (using read_blog_posts and read_blog_post_content), synthesize a concise, valuable reply (under 280 chars), and save it via the "write_draft" tool.
4. Your reply MUST link to the blog post or showcase a code snippet.
5. If a tweet is NOT a good fit, simply output a short reasoning explaination and stop without writing a draft.
6. Never write a generic bot reply like "Nice post! Check my blog". Write a targeted, contextual answer that solves their immediate pain point.
`

const getAlreadyDraftedTweetIds = (): Effect.Effect<ReadonlySet<string>, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const files = await readdir(DRAFTS_DIR)
        const ids = new Set<string>()
        for (const file of files) {
          // Filenames are in format reply_<tweetId>.md or post_<tweetId>.md
          const match = file.match(/^(?:reply|post)_(\d+)\.md$/)
          if (match && match[1]) {
            ids.add(match[1])
          }
        }
        return ids
      } catch {
        return new Set<string>()
      }
    },
    catch: (e) => new Error(`Failed to read pending drafts directory: ${String(e)}`),
  })

export const findOpportunitiesAndDraft = (queries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const x = yield* XPlatform
    const blog = yield* BlogReader
    const alreadyDrafted = yield* getAlreadyDraftedTweetIds()
    
    // Step 1: List blog posts for summaries
    const posts = yield* blog.getPosts()
    const postsSummary = posts
      .map((p) => `- [${p.title}](xandreed.dev/posts/${p.slug}): ${p.description}`)
      .join("\n")

    yield* Effect.logInfo(`Scanning X for opportunities matching: ${queries.join(", ")}`)

    for (const query of queries) {
      const results: ReadonlyArray<XSearchResult> = yield* x.search(query).pipe(
        Effect.catchAll((err) => {
          // Log search failure but continue with next queries
          return Effect.gen(function* () {
            yield* Effect.logError(`Search failed for query "${query}": ${err.message}`)
            return [] as ReadonlyArray<XSearchResult>
          })
        })
      )

      for (const tweet of results) {
        if (alreadyDrafted.has(tweet.id)) {
          // Already have a draft for this tweet
          continue
        }

        yield* Effect.logInfo(`Evaluating tweet from ${tweet.author} (${tweet.id})`)

        const messageText = `TWEET TO EVALUATE:
Author: ${tweet.author}
Text: "${tweet.text}"
URL: https://x.com/${tweet.author.replace("@", "")}/status/${tweet.id}

AVAILABLE BLOG POSTS TO PROPERLY REFERENCE:
${postsSummary}

Decide if this is an opportunity. If yes, read the relevant blog content using "read_blog_post_content" first, write a highly technical 1-tweet response (including the link to the post), and save it via "write_draft".`

        const messages: ReadonlyArray<AgentMessage> = [
          { role: "user", content: messageText },
        ]

        yield* runAgentLoop({
          system: SYSTEM_PROMPT,
          messages,
          toolkit: socialToolkit,
          maxSteps: 5,
        }).pipe(
          Effect.provide(SocialToolkitLive),
          Effect.tap((result) =>
            Effect.logInfo(`Evaluation complete for ${tweet.id}. Final text: ${result.finalText.slice(0, 100)}...`)
          ),
          Effect.catchAll((err) => {
            const fail = err as any
            return Effect.logError(`Reasoning loop failed for tweet ${tweet.id}: ${fail.message ?? fail.error ?? String(fail)}`)
          })
        )
      }
    }
  })
