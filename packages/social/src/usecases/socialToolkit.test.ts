import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { XPlatform, type XSearchResult } from "../ports/x-platform.port.js"
import { BlogReader } from "../ports/blog-reader.port.js"
import { LocalSocialWorkspaceLive, readLedger } from "../adapters/local-social-workspace.adapter.js"
import { makeSocialHandlers } from "./socialToolkit.js"

const NOW = new Date("2026-07-07T12:00:00Z")

const THREAD: ReadonlyArray<XSearchResult> = [
  { id: "111", author: "@someone", text: "how do I retry in effect?", timestamp: NOW.toISOString() },
]

const stubX = Layer.succeed(
  XPlatform,
  XPlatform.of({
    search: () => Effect.succeed([]),
    getNotifications: () => Effect.succeed([]),
    readThread: (id) => Effect.succeed(id === "111" ? THREAD : []),
    postTweet: () => Effect.die("never posts in tests"),
  }),
)

const stubBlog = Layer.succeed(
  BlogReader,
  BlogReader.of({
    getPosts: () =>
      Effect.succeed([
        { slug: "effect-retries", title: "Retries", description: "d", tags: [], content: "body" },
      ]),
    getPostContent: () => Effect.succeed("body"),
  }),
)

const withHandlers = <A>(
  f: (
    handlers: Effect.Effect.Success<ReturnType<typeof makeSocialHandlers>>,
    dirs: { pending: string; ledger: string },
  ) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "social-toolkit-"))
  const dirs = { pending: join(dir, "pending"), ledger: join(dir, "ledger.jsonl") }
  return Effect.runPromise(
    makeSocialHandlers({
      pendingDir: dirs.pending,
      ledgerPath: dirs.ledger,
      policyPath: join(dir, "policy.json"),
      now: () => NOW,
    }).pipe(
      Effect.flatMap((handlers) => f(handlers, dirs)),
      Effect.provide(Layer.mergeAll(stubX, stubBlog, LocalSocialWorkspaceLive)),
    ) as Effect.Effect<A, unknown, never>,
  )
}

describe("Gate A — write_draft is the chokepoint into the queue", () => {
  test("a reply drafted WITHOUT reading its thread bounces with thread-context, and the rejection is ledgered", async () => {
    const result = await withHandlers((handlers, dirs) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.either(
          handlers.write_draft({
            type: "reply",
            content: "Model it as a Schedule. https://xandreed.dev/posts/effect-retries",
            targetTweetId: "111",
            targetAuthor: "@someone",
            referenceBlogSlug: "effect-retries",
          }),
        )
        const ledger = yield* readLedger(dirs.ledger)
        return { outcome, ledger }
      }),
    )
    expect(result.outcome._tag).toBe("Left")
    if (result.outcome._tag === "Left") {
      const failure = result.outcome.left as { error: string; message?: string }
      expect(failure.error).toBe("GateRejected")
      expect(failure.message).toContain("thread-context")
    }
    expect(result.ledger).toHaveLength(1)
    expect(result.ledger[0]?.event).toBe("gate_rejected")
    expect(result.ledger[0]?.findings?.join("\n")).toContain("thread-context")
  })

  test("read_thread → write_draft passes; the draft file lands and the ledger records drafted; a re-draft of the same target dedups", async () => {
    const result = await withHandlers((handlers, dirs) =>
      Effect.gen(function* () {
        yield* handlers.read_thread({ tweetId: "111" })
        const first = yield* Effect.either(
          handlers.write_draft({
            type: "reply",
            content: "Model it as a Schedule and compose. https://xandreed.dev/posts/effect-retries",
            targetTweetId: "111",
            targetAuthor: "@someone",
            referenceBlogSlug: "effect-retries",
          }),
        )
        const second = yield* Effect.either(
          handlers.write_draft({
            type: "reply",
            content: "Another take on the same tweet.",
            targetTweetId: "111",
            targetAuthor: "@someone",
          }),
        )
        const ledger = yield* readLedger(dirs.ledger)
        return { first, second, ledger }
      }),
    )
    expect(result.first._tag).toBe("Right")
    if (result.first._tag === "Right") {
      expect(result.first.right.filename).toBe("reply_111.md")
    }
    expect(result.second._tag).toBe("Left")
    if (result.second._tag === "Left") {
      expect((result.second.left as { message?: string }).message).toContain("dedup")
    }
    expect(result.ledger.map((e) => e.event)).toEqual(["drafted", "gate_rejected"])
  })

  test("banned content + off-allowlist link + dead slug bounce together", async () => {
    const result = await withHandlers((handlers) =>
      Effect.gen(function* () {
        yield* handlers.read_thread({ tweetId: "111" })
        return yield* Effect.either(
          handlers.write_draft({
            type: "reply",
            content: "Nice post! see https://spam.example.com",
            targetTweetId: "111",
            targetAuthor: "@someone",
            referenceBlogSlug: "no-such-post",
          }),
        )
      }),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      const message = (result.left as { message?: string }).message ?? ""
      expect(message).toContain("banned-content")
      expect(message).toContain("link-allowlist")
      expect(message).toContain("blog-slug-exists")
    }
  })
})
