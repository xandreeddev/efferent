// E1b — constrained-JSON generation throughput per model: the ui-agent's
// first paint waits for a COMPLETE start_ui payload, so chars/sec on a
// governed JSON emission (not first-token latency) predicts page latency.
// Untracked experiment harness — not part of the battery.
import { homedir } from "node:os"
import { Duration, Effect, Option } from "effect"
import { LanguageModel } from "@effect/ai"
import { LanguageModelSelectionLive, LocalAuthStoreLive } from "@xandreed/providers"
import { CurrentModelCallPolicy, parseModelSelection } from "@xandreed/engine"

const MODELS = process.argv[2]!.split(",")
const PROMPT =
  'Emit ONLY a JSON array (no prose, no markdown fences) of exactly 20 objects, each {"id":"kebab-case-string","title":"a short title","summary":"one plain sentence"} describing sections of an observability product landing page.'
const TIMEOUT_S = 60

const probe = (model: string) =>
  Effect.gen(function* () {
    const selection = Option.getOrThrow(parseModelSelection(model))
    const service = yield* LanguageModel.LanguageModel.pipe(
      Effect.provide(LanguageModelSelectionLive(selection, Option.none())),
      Effect.provide(LocalAuthStoreLive(process.cwd(), homedir())),
    )
    const t0 = Date.now()
    const done = yield* LanguageModel.generateText({ prompt: PROMPT }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, service),
      Effect.locally(CurrentModelCallPolicy, Option.some({ effort: "low" as const, maxOutputTokens: 3000 })),
      Effect.timeout(Duration.seconds(TIMEOUT_S)),
      Effect.either,
    )
    const wall = Date.now() - t0
    if (done._tag === "Left") {
      console.log(`${model.padEnd(34)} FAILED/TIMEOUT after ${wall}ms: ${String(done.left).slice(0, 80)}`)
      return
    }
    const text = done.right.text
    const valid = Effect.try({ try: () => Array.isArray(JSON.parse(text.trim())), catch: () => false })
    const parsed = yield* valid.pipe(Effect.orElseSucceed(() => false))
    console.log(
      `${model.padEnd(34)} total ${String(wall).padStart(6)}ms · ${String(text.length).padStart(5)} chars · ${String(Math.round((text.length / wall) * 1000)).padStart(5)} chars/s · valid-json=${parsed}`,
    )
  }).pipe(Effect.catchAll((e) => Effect.sync(() => console.log(`${model.padEnd(34)} ERROR: ${String(e).slice(0, 110)}`))))

await Effect.runPromise(
  Effect.forEach(MODELS, probe, { concurrency: 2 }).pipe(Effect.asVoid),
)
