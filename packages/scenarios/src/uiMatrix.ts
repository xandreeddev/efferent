import { LanguageModel } from "@effect/ai"
import { Context, Duration, Effect, Layer, Option, Stream } from "effect"
import { ConversationStore, parseModelSelection, toAgentFailure, toolResultFailure } from "@xandreed/engine"
import type { AgentFailureType } from "@xandreed/engine"
import { DefaultUiHostLive, SqliteUiPageStoreLive, makeCanvasSession } from "@xandreed/canvas"
import { LanguageModelSelectionLive, LocalAuthStoreLive, SqliteConversationStoreLive } from "@xandreed/providers"
import { UI_COMPOSER_PROMPT_VERSION, UI_PLANNER_PROMPT_VERSION, UI_REPAIR_PROMPT_VERSION, UiAgentExecutionProfile, UiAgentModels, UiHost, UiPageStore, foldPageEvents, validateBlocks, validateManifest, validatePageCompleteness } from "@xandreed/ui-agent"
import type { UiAgentProfileType, UiPage } from "@xandreed/ui-agent"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { wilsonInterval } from "./framework/stats.js"
import { makeUiPageQualityJudge } from "./judges/uiPageQuality.js"
import { generalTierCall, preflightAuth } from "./live/llm.js"

type Effort = "low" | "medium" | "high"

interface Candidate {
  readonly model: string
  readonly effort: Effort
}

interface MatrixTask {
  readonly id: string
  readonly prompt: string
  readonly terms: ReadonlyArray<string>
}

interface MatrixBudgets {
  readonly plannerTimeoutMs: number
  readonly composerTimeoutMs: number
  readonly trialTimeoutMs: number
}

interface Trial {
  readonly candidate: Candidate
  readonly task: string
  readonly request: string
  readonly sample: number
  readonly firstVisibleMs: number
  readonly initialCompleteMs: number
  readonly firstRefinementMs: number | null
  readonly enrichmentMs: number
  readonly acceptedRefinements: number
  readonly errors: ReadonlyArray<string>
  readonly failures: ReadonlyArray<AgentFailureType>
  readonly complete: boolean
  readonly designSystemScore: number
  readonly informationArchitectureScore: number
  readonly relevance: number
  readonly page: UiPage | null
}

interface RankedCandidate {
  readonly candidate: Candidate
  readonly trials: ReadonlyArray<Trial>
  readonly refinementSuccesses: number
  readonly withinTenSeconds: number
  readonly reliabilityLcb90: number
  readonly latencyLcb90: number
  readonly p50EnrichmentMs: number
  readonly p95EnrichmentMs: number
  readonly meanDesignSystemScore: number
  readonly meanInformationArchitectureScore: number
  readonly meanRelevance: number
  readonly repeatConsistency: number
  readonly deterministicScore: number
  readonly judgeScore?: number
  readonly selectionScore: number
}

// General-purpose models only: this matrix evaluates information architecture,
// copy, and governed composition—not code generation.
const DEFAULT_MODELS = [
  "opencode:deepseek-v4-flash",
  "opencode:kimi-k2.6",
  "opencode:glm-5.2",
  "openai-codex:gpt-5.6-luna",
]
const DEFAULT_EFFORTS: ReadonlyArray<Effort> = ["low", "medium", "high"]
const TASKS: ReadonlyArray<MatrixTask> = [
  { id: "recipe-app", prompt: "Build an Italian recipe application with regional discovery, saved recipes, and ingredient search.", terms: ["italian", "recipe", "regional", "ingredient", "saved"] },
  { id: "observability-landing", prompt: "Build a high-quality landing page for an observability product helping small teams understand production incidents.", terms: ["observability", "small", "teams", "production", "incidents"] },
  { id: "architecture-doc", prompt: "Build an architecture document for an Effect-native ports-and-adapters service with a dependency diagram and decisions.", terms: ["effect", "ports", "adapters", "dependency", "decisions"] },
]

const argValue = (name: string): Option.Option<string> => {
  const at = process.argv.indexOf(name)
  return Option.fromNullable(at < 0 ? undefined : process.argv[at + 1])
}

const csv = (name: string, fallback: ReadonlyArray<string>): ReadonlyArray<string> => Option.match(argValue(name), {
  onNone: () => fallback,
  onSome: (value) => value.split(",").map((entry) => entry.trim()).filter(Boolean),
})

const positiveInt = (name: string, fallback: number): number => Option.match(argValue(name), {
  onNone: () => fallback,
  onSome: (value) => {
    const parsed = Math.floor(Number(value))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  },
})

const percentile = (values: ReadonlyArray<number>, q: number): number => {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(q * ordered.length) - 1))]!
}

const mean = (values: ReadonlyArray<number>): number => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

const standardDeviation = (values: ReadonlyArray<number>): number => {
  const average = mean(values)
  return values.length < 2 ? 0 : Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
}

const relevance = (page: UiPage, terms: ReadonlyArray<string>): number => {
  const content = JSON.stringify(page.blocks).toLowerCase()
  return terms.filter((term) => content.includes(term)).length / terms.length
}

const informationArchitecture = (page: UiPage): number => {
  const ids = new Set(page.blocks.map((block) => block.id))
  const slotOrder = new Map(page.manifest.slots.map((slot, index) => [slot.id, index]))
  const positions = page.blocks.map((block) => slotOrder.get(block.id) ?? Number.POSITIVE_INFINITY)
  const ordered = positions.every((position, index) => index === 0 || position >= positions[index - 1]!)
  const navigationTargets = page.blocks.flatMap((block) => block.kind === "navigation" ? block.links.map((link) => link.target) : [])
  const targetsResolve = navigationTargets.every((target) => ids.has(target))
  const expectedFirst = page.manifest.archetype === "application" ? "navigation" : "hero"
  const checks = [ordered, targetsResolve, page.blocks[0]?.kind === expectedFirst, validatePageCompleteness(page).length === 0]
  return checks.filter(Boolean).length / checks.length
}

const repeatConsistency = (trials: ReadonlyArray<Trial>): number => {
  const byTask = [...new Set(trials.map((trial) => trial.task))].map((task) => trials.filter((trial) => trial.task === task))
  if (byTask.every((group) => group.length < 2)) return 0
  return mean(byTask.map((group) => {
    if (group.length < 2) return 0
    const relevanceSpread = Math.min(1, standardDeviation(group.map((trial) => trial.relevance)) * 2)
    const successSpread = Math.min(1, standardDeviation(group.map((trial) => trial.acceptedRefinements > 0 ? 1 : 0)) * 2)
    return Math.max(0, 1 - (relevanceSpread + successSpread) / 2)
  }))
}

const profileFor = (candidate: Candidate, budgets: MatrixBudgets): UiAgentProfileType => ({
  profile: "streaming-ui-v1", version: "matrix-v1", schemaVersion: "1.0.0", recipeSetVersion: "1.0.0",
  prompts: { planner: UI_PLANNER_PROMPT_VERSION, composer: UI_COMPOSER_PROMPT_VERSION, repair: UI_REPAIR_PROMPT_VERSION },
  planner: { model: candidate.model, effort: candidate.effort, timeoutMs: budgets.plannerTimeoutMs, maxOutputTokens: 1800, maxSteps: 2 },
  composer: { model: candidate.model, effort: candidate.effort, timeoutMs: budgets.composerTimeoutMs, maxOutputTokens: 6000, maxSteps: 5 },
  repair: { model: candidate.model, effort: candidate.effort, timeoutMs: 8_000, maxOutputTokens: 1800, maxSteps: 2, maxAttempts: 1 },
  fallback: { policy: "none" },
})

const selectedModel = (candidate: Candidate) => Effect.gen(function* () {
  const selection = Option.getOrThrow(parseModelSelection(candidate.model))
  return yield* LanguageModel.LanguageModel.pipe(
    Effect.provide(LanguageModelSelectionLive(selection, Option.none())),
    Effect.provide(LocalAuthStoreLive(process.cwd(), homedir())),
  )
})

const runTrial = (candidate: Candidate, task: MatrixTask, sample: number, budgets: MatrixBudgets): Effect.Effect<Trial, unknown> =>
  Effect.scoped(Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "efferent-ui-matrix-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    const db = join(dir, "canvas.db")
    const model = yield* selectedModel(candidate)
    const base = Layer.mergeAll(
      SqliteConversationStoreLive(db),
      SqliteUiPageStoreLive(db),
      DefaultUiHostLive,
      LocalAuthStoreLive(process.cwd(), homedir()),
      Layer.succeed(UiAgentExecutionProfile, profileFor(candidate, budgets)),
      Layer.succeed(UiAgentModels, { planner: model, composer: model, repair: model }),
    )
    const services = yield* Layer.build(base)
    const conversations = Context.get(services, ConversationStore)
    const pages = Context.get(services, UiPageStore)
    const host = Context.get(services, UiHost)
    const conversationId = yield* conversations.create(dir).pipe(Effect.orDie)
    const session = yield* makeCanvasSession({ conversationId }).pipe(Effect.provide(services))
    const startedAt = Date.now()
    yield* session.send(task.prompt)
    yield* session.subscribe(0).pipe(
      Stream.filter((entry) => entry.event.type === "agent_end"),
      Stream.runHead,
      Effect.timeout(Duration.millis(budgets.trialTimeoutMs)),
    )
    const finishedAt = Date.now()
    const sessionState = yield* session.state
    const events = yield* pages.list(conversationId).pipe(Effect.orDie)
    const page = foldPageEvents(events).at(-1)
    const opened = events.find((event) => event.type === "page_opened")
    const completed = events.find((event) => event.type === "page_completed")
    const refinements = events.filter((event) => event.type === "blocks_upserted")
    const acceptedRefinements = refinements.length
    const designFindings = page === undefined ? ["model produced no page"] : [...validateManifest(page.manifest, host), ...validateBlocks(page.manifest, page.blocks, host)]
    const failures = sessionState.log.flatMap((entry): ReadonlyArray<AgentFailureType> => {
      if (entry.event.type === "error") {
        return [entry.event.failure ?? toAgentFailure(entry.event.message, "session")]
      }
      if (entry.event.type === "tool_end" && !entry.event.ok) {
        return [toolResultFailure(entry.event.result, entry.event.toolName)]
      }
      return []
    })
    return {
      candidate, task: task.id, request: task.prompt, sample,
      firstVisibleMs: opened === undefined ? Number.POSITIVE_INFINITY : opened.at - startedAt,
      initialCompleteMs: completed === undefined ? Number.POSITIVE_INFINITY : completed.at - startedAt,
      firstRefinementMs: refinements[0] === undefined ? null : refinements[0].at - startedAt,
      enrichmentMs: finishedAt - startedAt,
      acceptedRefinements,
      errors: failures.map((failure) => `[${failure.stage}/${failure.code}] ${failure.message}`),
      failures,
      complete: page !== undefined && page.complete && validatePageCompleteness(page).length === 0,
      designSystemScore: designFindings.length === 0 ? 1 : 0,
      informationArchitectureScore: page === undefined ? 0 : informationArchitecture(page),
      relevance: page === undefined ? 0 : relevance(page, task.terms),
      page: page ?? null,
    }
  }))

const rank = (candidate: Candidate, trials: ReadonlyArray<Trial>): RankedCandidate => {
  const refinementSuccesses = trials.filter((trial) => trial.acceptedRefinements > 0 && trial.complete && trial.designSystemScore === 1 && trial.informationArchitectureScore === 1 && trial.relevance >= 0.6).length
  const withinTenSeconds = trials.filter((trial) => trial.firstRefinementMs !== null && trial.firstRefinementMs <= 10_000).length
  const reliabilityLcb90 = wilsonInterval(refinementSuccesses, trials.length, 1.645).low
  const latencyLcb90 = wilsonInterval(withinTenSeconds, trials.length, 1.645).low
  const p50EnrichmentMs = percentile(trials.map((trial) => trial.firstRefinementMs ?? trial.enrichmentMs), 0.5)
  const p95EnrichmentMs = percentile(trials.map((trial) => trial.enrichmentMs), 0.95)
  const meanDesignSystemScore = mean(trials.map((trial) => trial.designSystemScore))
  const meanInformationArchitectureScore = mean(trials.map((trial) => trial.informationArchitectureScore))
  const meanRelevance = mean(trials.map((trial) => trial.relevance))
  const consistency = repeatConsistency(trials)
  const latencyUtility = refinementSuccesses === 0 ? 0 : Math.exp(-p50EnrichmentMs / 10_000)
  const eligibleConsistency = refinementSuccesses === 0 ? 0 : consistency
  const deterministicScore = refinementSuccesses === 0 ? 0 : 0.25 * reliabilityLcb90 + 0.20 * latencyLcb90 + 0.15 * meanDesignSystemScore + 0.15 * meanInformationArchitectureScore + 0.10 * meanRelevance + 0.10 * latencyUtility + 0.05 * eligibleConsistency
  return { candidate, trials, refinementSuccesses, withinTenSeconds, reliabilityLcb90, latencyLcb90, p50EnrichmentMs, p95EnrichmentMs, meanDesignSystemScore, meanInformationArchitectureScore, meanRelevance, repeatConsistency: eligibleConsistency, deterministicScore, selectionScore: deterministicScore }
}

const judgeCandidate = (
  candidate: RankedCandidate,
  call: (prompt: string) => Effect.Effect<string, unknown>,
): Effect.Effect<RankedCandidate, never> => {
  const judge = makeUiPageQualityJudge<{ readonly page: UiPage; readonly request: string }>({ page: (world) => Effect.succeed(world.page), request: (world) => Effect.succeed(world.request), call })
  return Effect.forEach(candidate.trials, (trial) => trial.page === null
    ? Effect.succeed(0)
    : judge.run({ page: trial.page, request: trial.request }).pipe(
      Effect.map((result) => result.score),
      Effect.catchAll(() => Effect.succeed(0)),
    ), { concurrency: 1 }).pipe(
    Effect.map((scores) => {
      const judgeScore = mean(scores)
      return { ...candidate, judgeScore, selectionScore: 0.7 * candidate.deterministicScore + 0.3 * judgeScore }
    }),
  )
}

const persist = (path: string, value: unknown): Effect.Effect<void, Error> => Effect.try({
  try: () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  },
  catch: (cause) => new Error(`failed to persist UI matrix: ${String(cause)}`),
})

const program = Effect.gen(function* () {
  const keyed = yield* preflightAuth(process.cwd())
  if (!keyed) return yield* Effect.fail("no model credential; run Smith :login first")
  const efforts = csv("--efforts", DEFAULT_EFFORTS).filter((value): value is Effort => value === "low" || value === "medium" || value === "high")
  const candidates = csv("--models", DEFAULT_MODELS).flatMap((model) => efforts.map((effort) => ({ model, effort })))
  const taskIds = csv("--tasks", TASKS.map((task) => task.id))
  const unknownTasks = taskIds.filter((id) => !TASKS.some((task) => task.id === id))
  if (unknownTasks.length > 0) return yield* Effect.fail(`unknown UI matrix task(s): ${unknownTasks.join(", ")}`)
  const tasks = TASKS.filter((task) => taskIds.includes(task.id))
  const samples = positiveInt("--samples", 1)
  const top = positiveInt("--top", 3)
  const concurrency = positiveInt("--concurrency", 3)
  const plannerTimeoutMs = positiveInt("--planner-timeout-ms", 120_000)
  const composerTimeoutMs = positiveInt("--composer-timeout-ms", 180_000)
  const trialTimeoutMs = positiveInt("--trial-timeout-ms", plannerTimeoutMs + composerTimeoutMs + 15_000)
  const budgets = { plannerTimeoutMs, composerTimeoutMs, trialTimeoutMs }
  const combinations = candidates.flatMap((candidate) => tasks.flatMap((task) => Array.from({ length: samples }, (_, sample) => ({ candidate, task, sample: sample + 1 }))))
  console.log(`ui-matrix: ${candidates.length} candidates × ${tasks.length} tasks × ${samples} sample(s) = ${combinations.length} trials · concurrency=${concurrency} · profiling budgets=${plannerTimeoutMs}/${composerTimeoutMs}/${trialTimeoutMs}ms`)
  const trials = yield* Effect.forEach(combinations, ({ candidate, task, sample }) =>
    Effect.logInfo(`ui-matrix ${candidate.model} effort=${candidate.effort} task=${task.id} sample=${sample}`).pipe(
      Effect.zipRight(runTrial(candidate, task, sample, budgets)),
      Effect.tap((trial) => Effect.sync(() => console.log(`  ${candidate.model} ${candidate.effort} ${task.id}: visible=${trial.firstVisibleMs}ms complete=${trial.initialCompleteMs}ms first-patch=${trial.firstRefinementMs ?? "none"} enrich=${trial.enrichmentMs}ms patches=${trial.acceptedRefinements} ds=${trial.designSystemScore.toFixed(2)} ia=${trial.informationArchitectureScore.toFixed(2)} relevance=${trial.relevance.toFixed(2)}`))),
    ),
  { concurrency })
  const ranked = candidates.map((candidate) => rank(candidate, trials.filter((trial) => trial.candidate.model === candidate.model && trial.candidate.effort === candidate.effort))).sort((a, b) => b.deterministicScore - a.deterministicScore)
  const judgeModel = argValue("--judge-model")
  const judgeCall = yield* Option.match(judgeModel, {
    onNone: () => Effect.succeed(generalTierCall(process.cwd())),
    onSome: (model) => selectedModel({ model, effort: "high" }).pipe(
      Effect.map((service) => (prompt: string): Effect.Effect<string, unknown> => LanguageModel.generateText({ prompt }).pipe(
        Effect.map((response) => response.text),
        Effect.provideService(LanguageModel.LanguageModel, service),
      )),
    ),
  })
  const finalists = ranked.filter((candidate) => candidate.refinementSuccesses > 0).slice(0, top)
  const judgedFinalists = process.argv.includes("--no-judge")
    ? finalists
    : yield* Effect.forEach(finalists, (candidate) => judgeCandidate(candidate, judgeCall), { concurrency: 1 })
  const judgedByCandidate = new Map(judgedFinalists.map((candidate) => [`${candidate.candidate.model}:${candidate.candidate.effort}`, candidate]))
  const judged = ranked.map((candidate) => judgedByCandidate.get(`${candidate.candidate.model}:${candidate.candidate.effort}`) ?? candidate)
  const final = judged.sort((a, b) => b.selectionScore - a.selectionScore)
  const output = Option.getOrElse(argValue("--output"), () => join(process.cwd(), ".efferent", "evals", `ui-agent-matrix-${new Date().toISOString().replace(/[:.]/g, "-")}.json`))
  const report = { version: "ui-agent-matrix-v3", generatedAt: new Date().toISOString(), judgeModel: Option.getOrElse(judgeModel, () => "configured-general"), formula: "deterministic = .25*Wilson90(valid refinement) + .20*Wilson90(first patch <=10s) + .15*design-system compliance + .15*information architecture + .10*request relevance + .10*exp(-p50 first-patch/10s) + .05*repeat consistency; finalist selection = .70*deterministic + .30*fixed-judge quality", tasks, candidates: final }
  yield* persist(output, report)
  console.log("\nrank  model                            effort  success  <=10s  p50     p95     DS    IA    rel   cons  judge  score")
  final.forEach((entry, index) => console.log(`${String(index + 1).padStart(4)}  ${entry.candidate.model.padEnd(32)} ${entry.candidate.effort.padEnd(6)}  ${String(entry.refinementSuccesses).padStart(2)}/${String(entry.trials.length).padEnd(2)}    ${String(entry.withinTenSeconds).padStart(2)}/${String(entry.trials.length).padEnd(2)}  ${String(entry.p50EnrichmentMs).padStart(6)}  ${String(entry.p95EnrichmentMs).padStart(6)}  ${entry.meanDesignSystemScore.toFixed(2)}  ${entry.meanInformationArchitectureScore.toFixed(2)}  ${entry.meanRelevance.toFixed(2)}  ${entry.repeatConsistency.toFixed(2)}  ${(entry.judgeScore?.toFixed(2) ?? "-").padStart(5)}  ${entry.selectionScore.toFixed(3)}`))
  console.log(`evidence: ${output}`)
  return final.some((candidate) => candidate.refinementSuccesses > 0) ? 0 : 1
})

if (process.argv[1]?.endsWith("uiMatrix.ts") === true) {
  process.exit(await Effect.runPromise(program))
}
