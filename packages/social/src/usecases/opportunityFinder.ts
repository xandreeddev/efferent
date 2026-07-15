import { Effect, Option } from "effect"
import { CurrentModelCallPolicy, runLoop, type AgentMessage } from "@xandreed/engine"
import { engagedTweetIds } from "../domain/ledger.entity.functions.js"
import { LEDGER_PATH } from "../domain/paths.js"
import { SocialWorkspace } from "../ports/social-workspace.port.js"
import { BlogReader } from "../ports/blog-reader.port.js"
import { XPlatform, type XSearchResult } from "../ports/x-platform.port.js"
import { socialToolkit, SocialToolkitLive } from "./socialToolkit.js"

import { socialAgentSystemPrompt, socialTweetMessage } from "../prompt.js"

/** Targets we've ALREADY engaged — the durable ledger is the truth (dedup
 *  used to consult directory names, which forgot discarded/posted work). */
const getAlreadyEngagedTweetIds = (): Effect.Effect<ReadonlySet<string>, never, SocialWorkspace> =>
  SocialWorkspace.pipe(
    Effect.flatMap((workspace) => workspace.readLedger(LEDGER_PATH)),
    Effect.map(engagedTweetIds),
  )

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

              const messages: ReadonlyArray<AgentMessage> = [
                { role: "user", content: socialTweetMessage({ author: tweet.author, text: tweet.text, id: tweet.id, postsSummary }) },
              ]

              yield* runLoop({
                system: socialAgentSystemPrompt(),
                messages,
                toolkit: socialToolkit,
                maxSteps: 8,
              }).pipe(
                Effect.provide(SocialToolkitLive),
                // The 2026-07-15 drafting matrix's pin (docs/evals/social-
                // matrix-campaign-2026-07-15.md): effort MEDIUM — perfect
                // draft/abstain discipline, judge 0.93, earned-only links.
                // The model follows the general role; re-run
                // `bun run evals:social-matrix` before trusting a role change.
                Effect.locally(CurrentModelCallPolicy, Option.some({ effort: "medium" as const, maxOutputTokens: 2000 })),
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
