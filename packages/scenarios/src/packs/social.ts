import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Ref } from "effect"
import {
  BlogReader,
  makeSocialHandlers,
  readLedger,
  XPlatform,
} from "@xandreed/social"
import type { XSearchResult } from "@xandreed/social"
import type { Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"

const NOW = new Date("2026-07-12T12:00:00.000Z")
const THREAD: ReadonlyArray<XSearchResult> = [
  {
    id: "111",
    author: "@developer",
    text: "How should Effect retries be composed?",
    timestamp: NOW.toISOString(),
  },
]

const edge = Layer.mergeAll(
  Layer.succeed(
    XPlatform,
    XPlatform.of({
      search: () => Effect.succeed([]),
      getNotifications: () => Effect.succeed([]),
      readThread: (id) => Effect.succeed(id === "111" ? THREAD : []),
      postTweet: () => Effect.die("the scenario must never post"),
    }),
  ),
  Layer.succeed(
    BlogReader,
    BlogReader.of({
      getPosts: () =>
        Effect.succeed([
          {
            slug: "effect-retries",
            title: "Effect retries",
            description: "Composing retry schedules",
            tags: ["effect"],
            content: "body",
          },
        ]),
      getPostContent: () => Effect.succeed("body"),
    }),
  ),
)

interface SocialWorld {
  readonly pending: string
  readonly ledger: string
  readonly blindRejected: Ref.Ref<boolean>
  readonly accepted: Ref.Ref<boolean>
  readonly dedupRejected: Ref.Ref<boolean>
  readonly blind: Effect.Effect<void>
  readonly readAndDraft: Effect.Effect<void>
  readonly duplicate: Effect.Effect<void>
}

const failureMessage = (failure: unknown): string =>
  typeof failure === "object" && failure !== null && "message" in failure
    ? String(failure.message)
    : String(failure)

const bootSocial = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "scenario-social-"))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
  const pending = join(dir, "pending")
  const ledger = join(dir, "ledger.jsonl")
  const handlers = yield* makeSocialHandlers({
    pendingDir: pending,
    ledgerPath: ledger,
    policyPath: join(dir, "policy.json"),
    now: () => NOW,
  }).pipe(Effect.provide(edge))
  const blindRejected = yield* Ref.make(false)
  const accepted = yield* Ref.make(false)
  const dedupRejected = yield* Ref.make(false)
  const draft = {
    type: "reply" as const,
    content: "Compose a Schedule and keep the error channel typed. https://xandreed.dev/effect-retries",
    targetTweetId: "111",
    targetAuthor: "@developer",
    referenceBlogSlug: "effect-retries",
  }
  return {
    pending,
    ledger,
    blindRejected,
    accepted,
    dedupRejected,
    blind: handlers.write_draft(draft).pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          Ref.set(blindRejected, failureMessage(failure).includes("thread-context")),
        onSuccess: () => Ref.set(blindRejected, false),
      }),
    ),
    readAndDraft: handlers.read_thread({ tweetId: "111" }).pipe(
      Effect.zipRight(handlers.write_draft(draft)),
      Effect.matchEffect({
        onFailure: () => Ref.set(accepted, false),
        onSuccess: () => Ref.set(accepted, true),
      }),
    ),
    duplicate: handlers.write_draft({ ...draft, content: "A duplicate attempt." }).pipe(
      Effect.matchEffect({
        onFailure: (failure) => Ref.set(dedupRejected, failureMessage(failure).includes("dedup")),
        onSuccess: () => Ref.set(dedupRejected, false),
      }),
    ),
  } satisfies SocialWorld
})

export const socialPack: Pack = {
  name: "social",
  threshold: 1,
  scenarios: [
    scenario<SocialWorld>({
      name: "blind reply bounces → contextual draft queues → duplicate bounces",
      modes: ["scripted"],
      boot: bootSocial,
      steps: [
        {
          name: "blind drafting is rejected",
          act: (world) => world.blind,
          checks: [
            {
              name: "thread-context gate rejected the blind reply",
              severity: "hard",
              run: (world) => Ref.get(world.blindRejected).pipe(Effect.map((pass) => ({ pass }))),
            },
          ],
        },
        {
          name: "read the thread and queue one draft",
          act: (world) => world.readAndDraft,
          checks: [
            {
              name: "contextual draft was accepted",
              severity: "hard",
              run: (world) => Ref.get(world.accepted).pipe(Effect.map((pass) => ({ pass }))),
            },
            {
              name: "pending markdown exists",
              severity: "hard",
              run: (world) =>
                Effect.sync(() => ({ pass: existsSync(join(world.pending, "reply_111.md")) })),
            },
          ],
        },
        {
          name: "the same target cannot be drafted twice",
          act: (world) => world.duplicate,
          checks: [
            {
              name: "dedup rejected the duplicate",
              severity: "hard",
              run: (world) => Ref.get(world.dedupRejected).pipe(Effect.map((pass) => ({ pass }))),
            },
            {
              name: "ledger records reject, draft, reject in order",
              severity: "hard",
              run: (world) =>
                readLedger(world.ledger).pipe(
                  Effect.map((entries) => ({
                    pass: entries.map((entry) => entry.event).join(",") ===
                      "gate_rejected,drafted,gate_rejected",
                  })),
                ),
            },
          ],
        },
      ],
    }),
  ],
}
