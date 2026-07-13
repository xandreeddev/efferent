// E1 — transport latency floor per model: time-to-first-stream-part for a
// tiny completion, per credentialed model. This is the axis that decides
// whether the ≤10s first-patch contract is even reachable. Untracked
// experiment harness — not part of the battery.
import { homedir } from "node:os"
import { Duration, Effect, Option, Stream } from "effect"
import { LanguageModel } from "@effect/ai"
import { LanguageModelSelectionLive, LocalAuthStoreLive } from "@xandreed/providers"
import { CurrentModelCallPolicy, parseModelSelection } from "@xandreed/engine"

const MODELS = process.argv[2]!.split(",")
const PROMPT = "Reply with exactly: ok"
const TIMEOUT_S = 35

const probe = (model: string) =>
  Effect.gen(function* () {
    const selection = Option.getOrThrow(parseModelSelection(model))
    const service = yield* LanguageModel.LanguageModel.pipe(
      Effect.provide(LanguageModelSelectionLive(selection, Option.none())),
      Effect.provide(LocalAuthStoreLive(process.cwd(), homedir())),
    )
    const t0 = Date.now()
    const first = yield* Effect.gen(function* () {
      const firstPart = yield* LanguageModel.streamText({ prompt: PROMPT }).pipe(
        Stream.runHead,
        Effect.provideService(LanguageModel.LanguageModel, service),
      )
      return { firstMs: Date.now() - t0, got: Option.isSome(firstPart) }
    }).pipe(
      Effect.locally(CurrentModelCallPolicy, Option.some({ effort: "low" as const, maxOutputTokens: 16 })),
      Effect.timeout(Duration.seconds(TIMEOUT_S)),
      Effect.either,
    )
    const line = first._tag === "Right"
      ? `${model.padEnd(34)} first-part ${String(first.right.firstMs).padStart(6)}ms`
      : `${model.padEnd(34)} FAILED/TIMEOUT after ${Date.now() - t0}ms: ${String(first.left).slice(0, 90)}`
    console.log(line)
  }).pipe(Effect.catchAll((e) => Effect.sync(() => console.log(`${model.padEnd(34)} ERROR: ${String(e).slice(0, 110)}`))))

await Effect.runPromise(
  Effect.forEach(MODELS, probe, { concurrency: 2 }).pipe(Effect.asVoid),
)
