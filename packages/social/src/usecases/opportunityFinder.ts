import { Effect } from "effect"
import { runLoop, type AgentMessage } from "@xandreed/engine"
import { engagedTweetIds, readLedger } from "../domain/Ledger.js"
import { LEDGER_PATH } from "../domain/paths.js"
import { BlogReader } from "../ports/BlogReader.js"
import { XPlatform, type XSearchResult } from "../ports/XPlatform.js"
import { socialToolkit, SocialToolkitLive } from "./socialToolkit.js"

const SYSTEM_PROMPT = `You are the automated social research agent for Xand Reed (@xandreeddev).
Your purpose is to find discussions on X (Twitter) where you can add genuine technical value, reply to queries, and drive traffic to your Astro blog (xandreed.dev) about building agents using Effect.ts.

You have access to tools to search X, get notifications, list your blog posts, read their content, and write drafts to your local review queue.

IMPORTANT STRATEGY:
1. DO NOT SPAM. Only reply when you can offer a concrete, technically precise answer.
2. Align with Xand Reed's identity: developer-centric, receipt-driven, zero hype, direct, using Effect.ts.
3. If a tweet is a good fit, find the most relevant blog post (using read_blog_posts and read_blog_post_content), synthesize a concise, valuable reply (under 280 chars), and save it via the "write_draft" tool.
4. Your reply MUST link to the blog post or showcase a code snippet.
5. If a tweet is NOT a good fit, simply output a short reasoning explanation and stop without writing a draft.
6. Never write a generic bot reply like "Nice post! Check my blog". Write a targeted, contextual answer that solves their immediate pain point.
`

/** Targets we've ALREADY engaged — the durable ledger is the truth (dedup
 *  used to consult directory names, which forgot discarded/posted work). */
const getAlreadyEngagedTweetIds = (): Effect.Effect<ReadonlySet<string>> =>
  readLedger(LEDGER_PATH).pipe(Effect.map(engagedTweetIds))

export const findOpportunitiesAndDraft = (queries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const x = yield* XPlatform
    const blog = yield* BlogReader
    const alreadyDrafted = yield* getAlreadyEngagedTweetIds()
    
    // Step 1: List blog posts for summaries
    const posts = yield* blog.getPosts()
    const postsSummary = posts
      .map((p) => `- [${p.title}](xandreed.dev/posts/${p.slug}): ${p.description}`)
      .join("\n")

    yield* Effect.logInfo(`Scanning X for opportunities matching: ${queries.join(", ")}`)

    yield* Effect.forEach(queries, (query) =>
      Effect.gen(function* () {
        const results: ReadonlyArray<XSearchResult> = yield* x.search(query).pipe(
          Effect.catchAll((err) =>
            Effect.logError(`Search failed for query "${query}": ${err.message}`).pipe(
              Effect.as([] as ReadonlyArray<XSearchResult>),
            ),
          ),
        )

        yield* Effect.forEach(
          results.filter((tweet) => !alreadyDrafted.has(tweet.id)),
          (tweet) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(`Evaluating tweet from ${tweet.author} (${tweet.id})`)

              const messageText = `TWEET TO EVALUATE:
Author: ${tweet.author}
Text: "${tweet.text}"
URL: https://x.com/${tweet.author.replace("@", "")}/status/${tweet.id}

AVAILABLE BLOG POSTS TO PROPERLY REFERENCE:
${postsSummary}

Decide if this is an opportunity. If yes, call "read_thread" on the tweet FIRST (a reply drafted without reading its thread is rejected), read the relevant blog content using "read_blog_post_content", write a highly technical 1-tweet response (including the link to the post), and save it via "write_draft". If write_draft rejects with policy findings, fix exactly what they say or drop the candidate.`

              const messages: ReadonlyArray<AgentMessage> = [
                { role: "user", content: messageText },
              ]

              yield* runLoop({
                system: SYSTEM_PROMPT,
                messages,
                toolkit: socialToolkit,
                maxSteps: 8,
              }).pipe(
                Effect.provide(SocialToolkitLive),
                Effect.tap((result) =>
                  Effect.logInfo(`Evaluation complete for ${tweet.id}. Final text: ${result.finalText.slice(0, 100)}...`),
                ),
                Effect.catchAll((err) => {
                  const detail =
                    typeof err === "object" && err !== null
                      ? ((err as { message?: string }).message ?? (err as { error?: string }).error ?? String(err))
                      : String(err)
                  return Effect.logError(`Reasoning loop failed for tweet ${tweet.id}: ${detail}`)
                }),
              )
            }),
          { discard: true },
        )
      }),
    { discard: true },
    )
  })
