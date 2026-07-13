// E4b — glm-5.2 low-vs-medium stability (is low pathological or was it a blip?)
import { homedir } from "node:os"
import { Duration, Effect, Option } from "effect"
import { LanguageModel } from "@effect/ai"
import { LanguageModelSelectionLive, LocalAuthStoreLive } from "@xandreed/providers"
import { CurrentModelCallPolicy, parseModelSelection } from "@xandreed/engine"

const PROMPT =
  'Emit ONLY a JSON object (no prose, no fences): {"id":"observability-hero","kind":"hero","title":"...","subtitle":"...","body":"one short paragraph"} — a landing hero for an observability product for small teams.'

const CASES = [
  { model: "opencode:glm-5.2", effort: "low" as const },
  { model: "opencode:glm-5.2", effort: "medium" as const },
  { model: "opencode:glm-5.2", effort: "low" as const },
  { model: "opencode:glm-5.2", effort: "medium" as const },
  { model: "opencode:glm-5.2", effort: "low" as const },
  { model: "opencode:glm-5.2", effort: "medium" as const },
  { model: "openai-codex:gpt-5.6-luna", effort: "low" as const },
  { model: "openai-codex:gpt-5.6-luna", effort: "low" as const },
]

const probe = ({ model, effort }: (typeof CASES)[number]) =>
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
        ? `${model.padEnd(28)} effort=${effort.padEnd(6)} ${String(wall).padStart(6)}ms`
        : `${model.padEnd(28)} effort=${effort.padEnd(6)} FAILED after ${wall}ms`,
    )
  }).pipe(Effect.catchAll((e) => Effect.sync(() => console.log(`${model} ${effort} ERROR: ${String(e).slice(0, 90)}`))))

await Effect.runPromise(Effect.forEach(CASES, probe, { concurrency: 1 }).pipe(Effect.asVoid))
