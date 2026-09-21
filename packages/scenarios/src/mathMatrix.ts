import { LanguageModel } from "@effect/ai"
import { Cause, Context, Duration, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationStore, CurrentModelCallPolicy, parseModelSelection, toAgentFailure } from "@xandreed/core"
import { LanguageModelSelectionLive, LocalAuthStoreLive } from "@xandreed/plugin-models"
import { SqliteConversationStoreLive } from "@xandreed/plugin-session-sqlite"
import { MATH_PROMPT_VERSION, composeAgentMessage, gradeAnswer, makeMathSession } from "@xandreed/math"
import type { MathExercise, MathSession, MathSessionEvent } from "@xandreed/math"
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { argValue, csv, fileStamp, grid, hasFlag, persistJson, positiveInt, runCampaign, runMatrixMain, trialFileName } from "@xandreed/evals/campaign"
import { mean, percentile, wilsonInterval } from "@xandreed/evals/stats"
import { generalTierCall, preflightAuth } from "./live/llm.js"

/**
 * The math authoring matrix — the evidence campaign behind the tutor's model
 * pin. Every trial drives the REAL math session (prompt, toolkit, admission,
 * SQLite trail) for one grade×theme task over two turns (start + more), then
 * scores the authored exercises deterministically: admission pass rate,
 * independent-solver key agreement (the G15 cross-check the in-handler gates
 * cannot run — admission stays LLM-free), variety, difficulty spread, and
 * latency. Provider errors and runtime defects settle as failed trial rows;
 * every settled trial persists immediately under the evidence `trials/` dir.
 */

type Effort = "low" | "medium" | "high"

interface Candidate {
  readonly model: string
  readonly effort: Effort
}

interface MatrixTask {
  readonly id: string
  readonly grade: number
  readonly theme: string
}

interface MatrixBudgets {
  readonly turnTimeoutMs: number
  readonly trialCapMs: number
}

interface Trial {
  readonly candidate: Candidate
  readonly task: MatrixTask
  readonly sample: number
  readonly complete: boolean
  readonly firstBatchMs: number
  readonly turn1Ms: number
  readonly turn2Ms: number
  readonly accepted1: number
  readonly accepted2: number
  readonly rejectedCount: number
  readonly rejectionReasons: ReadonlyArray<string>
  readonly admissionPassRate: number
  readonly batchConformant: boolean
  readonly answerKinds: ReadonlyArray<string>
  readonly difficulties: ReadonlyArray<string>
  readonly dedupBounces: number
  readonly solverChecked: number
  readonly solverAgreed: number
  readonly solverVerdicts: ReadonlyArray<SolverVerdict>
  readonly exercises: ReadonlyArray<MathExercise>
  readonly errors: ReadonlyArray<string>
}

const DEFAULT_MODELS: ReadonlyArray<string> = ["openai-codex:gpt-5.6-luna", "opencode:glm-5.2"]
const DEFAULT_EFFORTS: ReadonlyArray<Effort> = ["low", "medium"]

const TASKS: ReadonlyArray<MatrixTask> = [
  { id: "g2-addition", grade: 2, theme: "addition and subtraction with stickers" },
  { id: "g4-fractions", grade: 4, theme: "fractions" },
  { id: "g6-decimals", grade: 6, theme: "decimals and percentages" },
  { id: "g8-equations", grade: 8, theme: "linear equations" },
]

const selectedModel = (candidate: Candidate) => Effect.gen(function* () {
  const selection = Option.getOrThrow(parseModelSelection(candidate.model))
  return yield* LanguageModel.LanguageModel.pipe(
    Effect.provide(LanguageModelSelectionLive(selection, Option.none())),
    Effect.provide(LocalAuthStoreLive(process.cwd(), homedir())),
  )
})

const waitForAgentEnds = (session: MathSession, count: number, timeoutMs: number) => session.subscribe(0).pipe(
  Stream.filter((entry) => entry.event.type === "agent_end"),
  Stream.take(count),
  Stream.runDrain,
  Effect.timeout(Duration.millis(timeoutMs)),
)

/** One bounded turn. `session.send` may run the turn INLINE (serialized
 * send), so the deadline must wrap the send itself — a provider retry ladder
 * parked inside the turn otherwise runs to the trial's hard cap (observed in
 * the 2026-07-14 smoke). A timed-out turn degrades to partial evidence: the
 * trial goes on and scores whatever the session actually produced. */
const boundedTurn = (
  session: MathSession,
  message: string,
  agentEnds: number,
  timeoutMs: number,
  policy: Option.Option<{ readonly effort: Effort; readonly maxOutputTokens: number }>,
): Effect.Effect<void> =>
  session.send(message).pipe(
    Effect.locally(CurrentModelCallPolicy, policy),
    Effect.zipRight(waitForAgentEnds(session, agentEnds, timeoutMs)),
    Effect.timeout(Duration.millis(timeoutMs + 5_000)),
    Effect.asVoid,
    Effect.catchAll((error) => Effect.logWarning(`math-matrix turn gave up after ${timeoutMs}ms: ${String(error)}`)),
  )

const exercisesOf = (events: ReadonlyArray<MathSessionEvent>): ReadonlyArray<MathExercise> =>
  events.flatMap((event) => event.type === "math_render"
    ? event.items.flatMap((item) => item.kind === "exercise" ? [item] : [])
    : [])

const rejectionsOf = (events: ReadonlyArray<MathSessionEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => {
    if (event.type !== "tool_end" || event.toolName !== "render_math") return []
    const result = typeof event.result === "object" && event.result !== null
      ? (event.result as { rejected?: ReadonlyArray<{ reason?: string }> })
      : {}
    return (result.rejected ?? []).flatMap((entry) => entry.reason === undefined ? [] : [entry.reason])
  })

/** Independent-solver key agreement (G15): a general-tier model solves the
 * exercise WITHOUT seeing the key; the deterministic oracle then grades its
 * answer against the authored key. Disagreement means either a wrong key (the
 * product's worst failure) or an ambiguous prompt — both authoring defects. */
interface SolverVerdict {
  readonly id: string
  readonly reply: string
  readonly agreed: boolean
}

const solverAgreement = (
  exercises: ReadonlyArray<MathExercise>,
  call: (prompt: string) => Effect.Effect<string, unknown>,
): Effect.Effect<{ readonly checked: number; readonly agreed: number; readonly verdicts: ReadonlyArray<SolverVerdict> }> =>
  Effect.forEach(exercises.slice(0, 6), (exercise) => {
    const options = (exercise.choices ?? []).map((choice) => `${choice.id}) ${choice.label}`).join("  ")
    const ask = `Solve this exercise. Reply with ONLY the final answer — a number, a fraction like 3/4, or the correct option id LETTER — nothing else.\n\n${exercise.prompt}${options === "" ? "" : `\n\nOptions: ${options}`}`
    return call(ask).pipe(
      Effect.timeout(Duration.seconds(60)),
      Effect.map((reply) => {
        // Currency/unit prefixes are solver formatting, not disagreement
        // ("$51" for key "51" was the campaign's only luna-medium miss).
        const lastLine = (reply.trim().split("\n").at(-1) ?? "").trim().replace(/^[$€£]\s*/, "")
        return Option.some<SolverVerdict>({
          id: exercise.id,
          reply: lastLine.slice(0, 120),
          agreed: gradeAnswer(exercise.answer, lastLine).correct,
        })
      }),
      Effect.catchAll(() => Effect.succeed(Option.none<SolverVerdict>())),
    )
  }, { concurrency: 2 }).pipe(
    Effect.map((outcomes) => {
      const verdicts = outcomes.flatMap((outcome) => Option.isSome(outcome) ? [outcome.value] : [])
      return { checked: verdicts.length, agreed: verdicts.filter((verdict) => verdict.agreed).length, verdicts }
    }),
  )

const runTrial = (
  candidate: Candidate,
  task: MatrixTask,
  sample: number,
  budgets: MatrixBudgets,
  solve: (prompt: string) => Effect.Effect<string, unknown>,
): Effect.Effect<Trial, unknown> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => mkdtempSync(join(tmpdir(), "efferent-math-matrix-")),
      catch: (error) => error,
    }),
    (dir) => Effect.scoped(Effect.gen(function* () {
      const model = yield* selectedModel(candidate)
      const services = yield* Layer.build(Layer.mergeAll(
        SqliteConversationStoreLive(join(dir, ".efferent", "math.db")),
        Layer.succeed(LanguageModel.LanguageModel, model),
      ))
      const store = Context.get(services, ConversationStore)
      const conversationId = yield* store.create(dir).pipe(Effect.orDie)
      const session = yield* makeMathSession({ conversationId, cwd: dir }).pipe(Effect.provide(services))
      const policy = Option.some({ effort: candidate.effort, maxOutputTokens: 6000 })

      const firstBatch = yield* Ref.make<number | null>(null)
      const startedAt = Date.now()
      yield* Effect.forkScoped(session.subscribe(0).pipe(
        Stream.filter((entry) => entry.event.type === "math_render"),
        Stream.take(1),
        Stream.runDrain,
        Effect.zipRight(Ref.update(firstBatch, (current) => current ?? Date.now() - startedAt)),
      ))

      yield* boundedTurn(session, composeAgentMessage([], { kind: "start", grade: task.grade, theme: task.theme }), 1, budgets.turnTimeoutMs, policy)
      const turn1Ms = Date.now() - startedAt
      // Snapshot the COUNT before turn 2: the log may be a live reference.
      const turn1Count = (yield* session.state).log.length

      const moreAt = Date.now()
      yield* boundedTurn(session, composeAgentMessage([], { kind: "more" }), 2, budgets.turnTimeoutMs, policy)
      const turn2Ms = Date.now() - moreAt

      const log = (yield* session.state).log.map((entry) => entry.event)
      const turn1Events = log.slice(0, turn1Count)
      const turn2Events = log.slice(turn1Count)
      const exercises = exercisesOf(log)
      const rejectionReasons = rejectionsOf(log)
      const accepted1 = exercisesOf(turn1Events).length
      const accepted2 = exercisesOf(turn2Events).length
      const attempted = exercises.length + rejectionReasons.length
      const solved = yield* solverAgreement(exercises, solve)
      const firstBatchMs = (yield* Ref.get(firstBatch)) ?? Number.POSITIVE_INFINITY

      return {
        candidate,
        task,
        sample,
        complete: accepted1 > 0 && accepted2 > 0,
        firstBatchMs,
        turn1Ms,
        turn2Ms,
        accepted1,
        accepted2,
        rejectedCount: rejectionReasons.length,
        rejectionReasons,
        admissionPassRate: attempted === 0 ? 0 : exercises.length / attempted,
        batchConformant: accepted1 >= 3 && accepted1 <= 5,
        answerKinds: [...new Set(exercises.map((exercise) => exercise.answer.kind))],
        difficulties: [...new Set(exercises.flatMap((exercise) => exercise.difficulty === undefined ? [] : [exercise.difficulty]))],
        dedupBounces: rejectionReasons.filter((reason) => reason.includes("already served this session") || reason.includes("asks the same question")).length,
        solverChecked: solved.checked,
        solverAgreed: solved.agreed,
        solverVerdicts: solved.verdicts,
        exercises,
        errors: log.flatMap((event) => event.type === "error" ? [event.message] : []),
      }
    })),
    (dir) => Effect.try({
      try: () => rmSync(dir, { recursive: true, force: true }),
      catch: (error) => error,
    }).pipe(Effect.catchAll((error) => Effect.logWarning(`math-matrix could not remove ${dir}: ${String(error)}`))),
  )

const failedTrial = (candidate: Candidate, task: MatrixTask, sample: number, error: unknown): Trial => {
  const failure = toAgentFailure(error, "math-matrix")
  return {
    candidate, task, sample, complete: false,
    firstBatchMs: Number.POSITIVE_INFINITY, turn1Ms: Number.POSITIVE_INFINITY, turn2Ms: Number.POSITIVE_INFINITY,
    accepted1: 0, accepted2: 0, rejectedCount: 0, rejectionReasons: [],
    admissionPassRate: 0, batchConformant: false, answerKinds: [], difficulties: [],
    dedupBounces: 0, solverChecked: 0, solverAgreed: 0, solverVerdicts: [], exercises: [],
    errors: [`[${failure.code}] ${failure.message}`],
  }
}

interface RankedCandidate {
  readonly candidate: Candidate
  readonly trials: ReadonlyArray<Trial>
  readonly successes: number
  readonly successLcb: number
  readonly meanPassRate: number
  readonly solverAgreement: number
  readonly meanVariety: number
  readonly meanDifficultySpread: number
  readonly p50FirstBatchMs: number
  readonly p95TurnMs: number
  readonly score: number
}

const rank = (candidate: Candidate, trials: ReadonlyArray<Trial>): RankedCandidate => {
  const successes = trials.filter((trial) => trial.complete && trial.accepted1 >= 3 && trial.admissionPassRate >= 0.8).length
  const successLcb = wilsonInterval(successes, trials.length).low
  const meanPassRate = mean(trials.map((trial) => trial.admissionPassRate))
  const checked = trials.reduce((sum, trial) => sum + trial.solverChecked, 0)
  const agreed = trials.reduce((sum, trial) => sum + trial.solverAgreed, 0)
  const agreement = checked === 0 ? 0 : agreed / checked
  const meanVariety = mean(trials.map((trial) => Math.min(1, trial.answerKinds.length / 3)))
  const meanDifficultySpread = mean(trials.map((trial) => Math.min(1, trial.difficulties.length / 3)))
  const p50FirstBatchMs = percentile(trials.map((trial) => trial.firstBatchMs), 0.5)
  const p95TurnMs = percentile(trials.flatMap((trial) => [trial.turn1Ms, trial.turn2Ms]), 0.95)
  const latencyScore = Number.isFinite(p50FirstBatchMs) ? Math.max(0, 1 - p50FirstBatchMs / 45_000) : 0
  const score = 0.3 * successLcb + 0.25 * meanPassRate + 0.2 * agreement + 0.1 * meanVariety + 0.05 * meanDifficultySpread + 0.1 * latencyScore
  return { candidate, trials, successes, successLcb, meanPassRate, solverAgreement: agreement, meanVariety, meanDifficultySpread, p50FirstBatchMs, p95TurnMs, score }
}

const program = Effect.gen(function* () {
  const keyed = yield* preflightAuth(process.cwd())
  if (!keyed) return yield* Effect.fail("no model credential; run Smith :login first")
  const models = csv("--models", DEFAULT_MODELS)
  const efforts = csv("--efforts", DEFAULT_EFFORTS).flatMap((effort): ReadonlyArray<Effort> =>
    effort === "low" || effort === "medium" || effort === "high" ? [effort] : [])
  const samples = positiveInt("--samples", 2)
  const concurrency = positiveInt("--concurrency", 3)
  const turnTimeoutMs = positiveInt("--turn-timeout-ms", 120_000)
  const budgets: MatrixBudgets = { turnTimeoutMs, trialCapMs: turnTimeoutMs * 2 + 150_000 }
  const output = Option.getOrElse(argValue("--output"), () => `.efferent/evals/math-matrix-${fileStamp()}.json`)
  const evidenceDir = output.replace(/\.json$/, "-evidence")
  const solve = generalTierCall(process.cwd())

  const candidates = models.flatMap((model) => efforts.map((effort): Candidate => ({ model, effort })))
  const cells = grid(candidates, TASKS, samples)
  console.log(`math-matrix: ${candidates.length} candidates × ${TASKS.length} tasks × ${samples} sample(s) = ${cells.length} trials · concurrency=${concurrency} · turn budget=${turnTimeoutMs}ms · prompt=${MATH_PROMPT_VERSION}`)

  const trials = yield* runCampaign({
    name: "math-matrix",
    cells,
    concurrency,
    capMs: () => budgets.trialCapMs,
    run: ({ candidate, task, sample }) => runTrial(candidate, task, sample, budgets, solve),
    failed: ({ candidate, task, sample }, cause) => failedTrial(candidate, task, sample, cause),
    evidenceDir,
    trialVersion: "math-trial-v1",
    trialName: ({ candidate, task, sample }) => trialFileName([candidate.model, candidate.effort, task.id, sample]),
    describe: ({ candidate, task, sample }) => `${candidate.model} effort=${candidate.effort} task=${task.id} sample=${sample}`,
    summarize: (trial) => `${trial.candidate.model} ${trial.candidate.effort} ${trial.task.id}: first-batch=${trial.firstBatchMs}ms turns=${trial.turn1Ms}/${trial.turn2Ms}ms accepted=${trial.accepted1}+${trial.accepted2} rejected=${trial.rejectedCount} pass=${trial.admissionPassRate.toFixed(2)} solver=${trial.solverAgreed}/${trial.solverChecked} kinds=${trial.answerKinds.join("|")}`,
  })

  const ranked = candidates
    .map((candidate) => rank(candidate, trials.filter((trial) => trial.candidate.model === candidate.model && trial.candidate.effort === candidate.effort)))
    .sort((a, b) => b.score - a.score)

  const report = {
    version: "math-matrix-v1",
    generatedAt: new Date().toISOString(),
    prompt: MATH_PROMPT_VERSION,
    evidenceDir,
    trialEvidenceDir: join(evidenceDir, "trials"),
    formula: "score = .30*Wilson-LCB(complete & >=3 first-batch & pass>=.8) + .25*admission pass rate + .20*independent-solver key agreement + .10*answer-kind variety + .05*difficulty spread + .10*latency decay (45s first-batch)",
    tasks: TASKS,
    candidates: ranked,
  }
  yield* persistJson(output, report)
  console.log("\nrank  model                                   effort  success  pass  solver  variety  first-p50  turn-p95  score")
  ranked.forEach((entry, index) => console.log(`${String(index + 1).padStart(4)}  ${entry.candidate.model.padEnd(38)} ${entry.candidate.effort.padEnd(6)}  ${String(entry.successes).padStart(2)}/${String(entry.trials.length).padEnd(3)} ${entry.meanPassRate.toFixed(2)}  ${entry.solverAgreement.toFixed(2)}    ${entry.meanVariety.toFixed(2)}     ${String(entry.p50FirstBatchMs).padStart(8)}  ${String(entry.p95TurnMs).padStart(8)}  ${entry.score.toFixed(3)}`))
  console.log(`evidence: ${output}`)
  const allFailed = ranked.every((entry) => entry.successes === 0)
  if (allFailed && hasFlag("--strict")) return yield* Effect.fail("every candidate failed the math matrix")
  return 0
})

runMatrixMain("mathMatrix.ts", program)
