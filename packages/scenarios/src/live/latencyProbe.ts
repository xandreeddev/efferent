import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { LanguageModel, Prompt, Toolkit } from "@effect/ai"
import { HttpClientRequest } from "@effect/platform"
import { Cause, Duration, Effect, Either, Option, Redacted, Ref, Stream } from "effect"
import { AuthStore, CurrentModelCallPolicy, parseModelSelection } from "@xandreed/engine"
import {
  LanguageModelSelectionLive,
  LocalAuthStoreLive,
  OPENAI_CODEX_API_URL,
  OpenAiCodexWebSocketHttpClient,
} from "@xandreed/providers"
import { StartUi, uiPlannerPrompt } from "@xandreed/ui-agent"

/**
 * The ui-latency plan's two ARCHITECTURE-DECIDING probes
 * (docs/agents/ui-latency-plan.md — run these BEFORE building Phase 2):
 *
 * 1. `--probe parts` — does the codex route surface `tool-params-*` stream
 *    parts through `LanguageModel.streamText` (the vocabulary exists in
 *    @effect/ai; whether the undocumented subscription SSE emits argument
 *    deltas is unknown)? Runs the REAL planner prompt + start_ui tool and
 *    logs every part type with a wall-clock stamp. A `generateText` control
 *    call rides the same prompt for a settled-path baseline.
 *
 * 2. `--probe effort` — does the subscription route accept the `minimal` and
 *    `none` reasoning efforts below our pinned vocabulary? Sends a tiny
 *    request per effort over the SAME WebSocket transport production uses
 *    and records acceptance, wall time, and token usage.
 *
 * Evidence is printed AND persisted as JSON (`--out`). Requires codex auth
 * in ~/.efferent/auth.json; never run in CI.
 */

interface ProbePart {
  readonly tMs: number
  readonly type: string
  readonly chars?: number
}

interface PartsSample {
  readonly sample: number
  readonly outcome: string
  readonly totalMs: number
  readonly partCounts: Record<string, number>
  readonly firstPartMs: number | null
  readonly firstReasoningDeltaMs: number | null
  readonly firstTextDeltaMs: number | null
  readonly firstToolParamsMs: number | null
  readonly toolCallSettledMs: number | null
  readonly parts: ReadonlyArray<ProbePart>
}

interface EffortSample {
  readonly effort: string
  readonly sample: number
  readonly outcome: string
  readonly wallMs: number
  readonly firstEventMs: number | null
  readonly outputTokens: number | null
  readonly reasoningTokens: number | null
}

const argValue = (name: string): Option.Option<string> => {
  const at = process.argv.indexOf(name)
  return Option.fromNullable(at < 0 ? undefined : process.argv[at + 1])
}

const positiveInt = (name: string, fallback: number): number => Option.match(argValue(name), {
  onNone: () => fallback,
  onSome: (value) => {
    const parsed = Math.floor(Number(value))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  },
})

const persist = (path: string, value: unknown): Effect.Effect<void, Error> => Effect.try({
  try: () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  },
  catch: (cause) => new Error(`failed to persist the probe report: ${String(cause)}`),
})

const authStack = LocalAuthStoreLive(process.cwd(), homedir())

/** A realistic planner call: the real prompt contract shape, the real
 * start_ui schema — only the handler is a stub (the probe measures the wire,
 * not admission). */
const PROBE_CONTRACT = {
  designSystem: { id: "efferent-ds", version: "2.0.0" },
  recipes: ["landing.hero-grid", "app.workspace", "doc.architecture"],
  assets: [],
  capabilities: [],
  components: [
    "marketing.hero — props: title!, lede!, eyebrow",
    "navigation.navbar — props: brand!, items!",
    "content.feature-grid — props: title, items!",
  ],
}

const probeToolkit = Toolkit.make(StartUi)
const probeHandlers = probeToolkit.toLayer({
  start_ui: ({ page }) => Effect.succeed({ opened: true, pageId: page.id, accepted: 1 }),
})

const probePrompt = Prompt.make([
  { role: "system", content: uiPlannerPrompt(PROBE_CONTRACT, "native-tools") },
  {
    role: "user",
    content: "Build a small landing page for an observability product helping small teams understand incidents.",
  },
] as never)

const describePart = (part: unknown, startedAt: number): ProbePart => {
  const p = part as { readonly type?: string; readonly delta?: unknown }
  return {
    tMs: Date.now() - startedAt,
    type: p.type ?? "unknown",
    ...(typeof p.delta === "string" ? { chars: p.delta.length } : {}),
  }
}

const firstOf = (parts: ReadonlyArray<ProbePart>, type: string): number | null =>
  parts.find((part) => part.type === type)?.tMs ?? null

const summarizeParts = (sample: number, outcome: string, totalMs: number, parts: ReadonlyArray<ProbePart>): PartsSample => ({
  sample,
  outcome,
  totalMs,
  partCounts: parts.reduce<Record<string, number>>((counts, part) => ({ ...counts, [part.type]: (counts[part.type] ?? 0) + 1 }), {}),
  firstPartMs: parts[0]?.tMs ?? null,
  firstReasoningDeltaMs: firstOf(parts, "reasoning-delta"),
  firstTextDeltaMs: firstOf(parts, "text-delta"),
  firstToolParamsMs: firstOf(parts, "tool-params-start") ?? firstOf(parts, "tool-params-delta"),
  toolCallSettledMs: firstOf(parts, "tool-call"),
  parts,
})

const partsSample = (service: LanguageModel.Service, sample: number) => Effect.gen(function* () {
  const toolkit = yield* probeToolkit
  const startedAt = Date.now()
  const collected = yield* Ref.make<ReadonlyArray<ProbePart>>([])
  const outcome = yield* LanguageModel.streamText({ prompt: probePrompt, toolkit, concurrency: 1 }).pipe(
    Stream.runForEach((part) => Ref.update(collected, (all) => [...all, describePart(part, startedAt)])),
    Effect.provideService(LanguageModel.LanguageModel, service),
    Effect.timeout(Duration.seconds(120)),
    Effect.as("ok"),
    Effect.catchAllCause((cause) => Effect.succeed(`stream failed: ${Cause.pretty(cause).slice(0, 500)}`)),
  )
  const parts = yield* Ref.get(collected)
  return summarizeParts(sample, outcome, Date.now() - startedAt, parts)
}).pipe(
  Effect.provide(probeHandlers),
  Effect.locally(CurrentModelCallPolicy, Option.some({ effort: "medium" as const, maxOutputTokens: 2400 })),
)

const generateControl = (service: LanguageModel.Service) => Effect.gen(function* () {
  const toolkit = yield* probeToolkit
  const startedAt = Date.now()
  const outcome = yield* LanguageModel.generateText({ prompt: probePrompt, toolkit, concurrency: 1 }).pipe(
    Effect.provideService(LanguageModel.LanguageModel, service),
    Effect.timeout(Duration.seconds(120)),
    Effect.as("ok"),
    Effect.catchAllCause((cause) => Effect.succeed(`generateText failed: ${Cause.pretty(cause).slice(0, 500)}`)),
  )
  return { outcome, wallMs: Date.now() - startedAt }
}).pipe(
  Effect.provide(probeHandlers),
  Effect.locally(CurrentModelCallPolicy, Option.some({ effort: "medium" as const, maxOutputTokens: 2400 })),
)

const probeParts = (model: string, samples: number) => Effect.gen(function* () {
  const selection = Option.getOrThrow(parseModelSelection(model))
  const service = yield* LanguageModel.LanguageModel.pipe(
    Effect.provide(LanguageModelSelectionLive(selection, Option.none())),
    Effect.provide(authStack),
  )
  const streamed = yield* Effect.forEach(
    Array.from({ length: samples }, (_, index) => index + 1),
    (sample) => partsSample(service, sample).pipe(
      Effect.tap((result) => Effect.sync(() => console.log(
        `parts sample ${result.sample}: ${result.outcome} total=${result.totalMs}ms first=${result.firstPartMs}ms reasoning=${result.firstReasoningDeltaMs}ms text=${result.firstTextDeltaMs}ms tool-params=${result.firstToolParamsMs}ms tool-call=${result.toolCallSettledMs}ms counts=${JSON.stringify(result.partCounts)}`,
      ))),
    ),
    { concurrency: 1 },
  )
  const control = yield* generateControl(service)
  yield* Effect.sync(() => console.log(`generateText control: ${control.outcome} wall=${control.wallMs}ms`))
  return { model, samples: streamed, generateTextControl: control }
})

const DEFAULT_EFFORTS = ["none", "minimal", "low", "medium"] as const

const effortSample = (
  key: Redacted.Redacted<string>,
  accountId: string,
  modelId: string,
  effort: string,
  sample: number,
): Effect.Effect<EffortSample> => Effect.scoped(Effect.gen(function* () {
  const startedAt = Date.now()
  const request = HttpClientRequest.post(`${OPENAI_CODEX_API_URL}/responses`).pipe(
    HttpClientRequest.setHeaders({
      authorization: `Bearer ${Redacted.value(key)}`,
      "chatgpt-account-id": accountId,
      originator: "pi",
    }),
    HttpClientRequest.bodyUnsafeJson({
      model: modelId,
      store: false,
      stream: true,
      instructions: "You are a terse assistant.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly: ok" }] }],
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort, summary: "auto" },
      prompt_cache_key: `latency-probe-${effort}-${sample}`,
    }),
  )
  const response = yield* OpenAiCodexWebSocketHttpClient.execute(request)
  const frames = yield* response.stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.startsWith("data: ")),
    Stream.map((line) => ({
      tMs: Date.now() - startedAt,
      event: Either.getOrElse(Either.try(() => JSON.parse(line.slice(6)) as Record<string, unknown>), () => ({} as Record<string, unknown>)),
    })),
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
    Effect.timeout(Duration.seconds(90)),
  )
  const completed = frames.find((frame) => frame.event["type"] === "response.completed")
  const usage = ((completed?.event["response"] as Record<string, unknown> | undefined)?.["usage"] ?? {}) as {
    readonly output_tokens?: number
    readonly output_tokens_details?: { readonly reasoning_tokens?: number }
  }
  return {
    effort,
    sample,
    outcome: completed === undefined ? "no response.completed frame" : "accepted",
    wallMs: Date.now() - startedAt,
    firstEventMs: frames[0]?.tMs ?? null,
    outputTokens: usage.output_tokens ?? null,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
  }
})).pipe(
  Effect.catchAllCause((cause) => Effect.succeed({
    effort,
    sample,
    outcome: `rejected: ${Cause.pretty(cause).slice(0, 400)}`,
    wallMs: 0,
    firstEventMs: null,
    outputTokens: null,
    reasoningTokens: null,
  })),
)

const probeEfforts = (model: string, samples: number) => Effect.gen(function* () {
  const selection = Option.getOrThrow(parseModelSelection(model))
  const auth = yield* AuthStore
  const key = yield* auth.resolveKey(selection.provider)
  const credential = yield* auth.get(selection.provider)
  const accountId = Option.flatMap(credential, (value) =>
    value.type === "oauth" ? Option.fromNullable(value.accountId) : Option.none())
  const material = Option.all({ key, accountId })
  if (Option.isNone(material)) return yield* Effect.fail(`no ${selection.provider} oauth credential with an account id`)
  const efforts = Option.match(argValue("--efforts"), {
    onNone: () => [...DEFAULT_EFFORTS],
    onSome: (value) => value.split(",").map((entry) => entry.trim()).filter(Boolean),
  })
  return yield* Effect.forEach(efforts, (effort) =>
    Effect.forEach(
      Array.from({ length: samples }, (_, index) => index + 1),
      (sample) => effortSample(material.value.key, material.value.accountId, selection.modelId, effort, sample).pipe(
        Effect.tap((result) => Effect.sync(() => console.log(
          `effort=${result.effort} sample=${result.sample}: ${result.outcome.split("\n")[0]} wall=${result.wallMs}ms first=${result.firstEventMs}ms out=${result.outputTokens} reasoning=${result.reasoningTokens}`,
        ))),
      ),
      { concurrency: 1 },
    ), { concurrency: 1 }).pipe(Effect.map((nested) => nested.flat()))
}).pipe(Effect.provide(authStack))

const program = Effect.gen(function* () {
  const model = Option.getOrElse(argValue("--model"), () => "openai-codex:gpt-5.6-luna")
  const probe = Option.getOrElse(argValue("--probe"), () => "all")
  const samples = positiveInt("--samples", 2)
  const out = Option.getOrElse(
    argValue("--out"),
    () => join(process.cwd(), ".efferent", "evals", `ui-latency-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  )
  console.log(`ui-latency-probe: model=${model} probe=${probe} samples=${samples}`)
  const parts = probe === "parts" || probe === "all" ? yield* probeParts(model, samples) : null
  const efforts = probe === "effort" || probe === "all" ? yield* probeEfforts(model, samples) : null
  yield* persist(out, {
    version: "ui-latency-probe-v1",
    generatedAt: new Date().toISOString(),
    model,
    parts,
    efforts,
  })
  console.log(`evidence: ${out}`)
  return 0
})

if (process.argv[1]?.endsWith("latencyProbe.ts") === true) {
  process.exit(await Effect.runPromise(program.pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.error(String(error))
    return 1
  })))))
}
