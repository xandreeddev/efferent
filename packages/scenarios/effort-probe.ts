// E4a — does reasoning effort move wall time at planner-payload sizes?
// If low ≈ high, payload generation dominates and "dropping reasoning"
// buys little; if high >> low, sub-low reasoning is worth plumbing.
import { homedir } from "node:os"
import { Duration, Effect, Option } from "effect"
import { LanguageModel } from "@effect/ai"
import { LanguageModelSelectionLive, LocalAuthStoreLive } from "@xandreed/providers"
import { CurrentModelCallPolicy, parseModelSelection } from "@xandreed/engine"

const MODELS = ["openai-codex:gpt-5.6-luna", "opencode:glm-5.2"]
const EFFORTS = ["low", "medium", "high"] as const
const PROMPT =
  'Emit ONLY a JSON object (no prose, no fences): {"id":"observability-hero","kind":"hero","title":"...","subtitle":"...","body":"one short paragraph"} — a landing hero for an observability product for small teams.'

const probe = (model: string, effort: (typeof EFFORTS)[number]) =>
  Effect.gen(function* () {
    const selection = Option.getOrThrow(parseModelSelection(model))
    const service = yield* LanguageModel.LanguageModel.pipe(
      Effect.provide(LanguageModelSelectionLive(selection, Option.none())),
      Effect.provide(LocalAuthStoreLive(process.cwd(), homedir())),
    )
    const t0 = Date.now()
    const done = yield* LanguageModel.generateText({ prompt: PROMPT }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, service),
      Effect.locally(CurrentModelCallPolicy, Option.some({ effort, maxOutputTokens: 900 })),
      Effect.timeout(Duration.seconds(45)),
      Effect.either,
    )
    const wall = Date.now() - t0
    console.log(
      done._tag === "Right"
        ? `${model.padEnd(28)} effort=${effort.padEnd(6)} ${String(wall).padStart(6)}ms · ${done.right.text.length} chars`
        : `${model.padEnd(28)} effort=${effort.padEnd(6)} FAILED after ${wall}ms`,
    )
  }).pipe(Effect.catchAll((e) => Effect.sync(() => console.log(`${model} ${effort} ERROR: ${String(e).slice(0, 90)}`))))

await Effect.runPromise(
  Effect.forEach(
    MODELS.flatMap((model) => EFFORTS.map((effort) => ({ model, effort }))),
    ({ model, effort }) => probe(model, effort),
    { concurrency: 1 },
  ).pipe(Effect.asVoid),
)
