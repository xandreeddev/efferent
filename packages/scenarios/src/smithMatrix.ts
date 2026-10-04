import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Option, Schema } from "effect"
import { addUsage, zeroUsage } from "@xandreed/core"
import { SMITH_CONTROLLER_PROMPT_VERSION, SMITH_EDIT_SCHEMA_VERSION, SMITH_EDITOR_PROMPT_VERSION } from "@xandreed/smith"
import { smithCodingCases, SMITH_CODING_DATASET_VERSION } from "./smith-coding-cases.entity.js"
import { FLASH_PRICE, JEV_PRICE, VERCEL_FLASH_PRICE, VERCEL_JEV_PRICE } from "./smith-budget.entity.js"
import { makeSmithBudget, validateSmithCampaignModels } from "./smith-budget.entity.functions.js"
import { repositoryRoot } from "./smith-coding-fixture.adapter.js"
import { SmithCodingEvidence } from "./smith-coding-trial.entity.js"
import { SmithCalibrationCandidate } from "./smith-calibration.entity.js"
import { runSmithCodingCalibrations, smithEvidenceFilename } from "./smith-calibration.adapter.js"
import { smithLiveTransport } from "./smith-live-transport.adapter.js"

const argument = (args: ReadonlyArray<string>, flag: string, fallback: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] ?? fallback : fallback
/** A separate, explicit live edge. Importing cases or scenario packs never dispatches paid calls. */
export const runSmithMatrix = (args: ReadonlyArray<string>) => Effect.gen(function* () {
  const live = args.includes("--live")
  const main = argument(args, "--main", live ? "" : "opencode:fixture-controller")
  const fast = argument(args, "--fast", live ? "" : "opencode:fixture-editor")
  if (live && (main.length === 0 || fast.length === 0)) { console.error("smith evals: --live requires explicit --main and --fast; no requests sent"); return 2 }
  const validated = live ? yield* Effect.result(validateSmithCampaignModels(main, fast, [FLASH_PRICE, VERCEL_FLASH_PRICE])) : { _tag: "Success" as const, success: [] as ReadonlyArray<string> }
  if (validated._tag === "Failure") { console.error(`smith evals: ${validated.failure.message}; no requests sent`); return 2 }
  if (live && validated.success.length > 0 && !args.includes("--admit-subscription")) { console.error("smith evals: subscription controllers require --admit-subscription; no requests sent"); return 2 }
  const directory = resolve(argument(args, "--output", join(repositoryRoot, ".artifacts/evals/smith", new Date().toISOString().replaceAll(":", "-"))))
  if (existsSync(directory)) { console.error("smith evals: output directory already exists; choose an unused path to preserve prior evidence"); return 2 }
  const limits = { spendCapUsd: 10, maxRequests: 400, maxInputBytesPerRequest: 200_000, maxOutputTokensPerRequest: 4096, unpricedSelectors: validated.success, maxUnpricedRequests: 160 }
  const prices = [FLASH_PRICE, JEV_PRICE, VERCEL_FLASH_PRICE, VERCEL_JEV_PRICE]
  const budget = yield* makeSmithBudget(limits, prices)
  const transport = live ? Option.some(yield* smithLiveTransport(budget, limits.maxOutputTokensPerRequest)) : Option.none()
  const candidates = [
    { id: "controller-only", driverModel: main, editorModel: main, modules: ["foundations", "schema", "services", "concurrency", "ai", "architecture"] },
    { id: "split", driverModel: main, editorModel: fast, modules: ["foundations", "schema", "services", "concurrency", "ai", "architecture"] },
  ]
  const cells = candidates.flatMap((candidate) => smithCodingCases.flatMap((testCase) => [1, 2].map((sample) => ({ candidate, testCase, sample }))))
  yield* Effect.sync(() => { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "manifest.json"), `${JSON.stringify({ version: "1", mode: live ? "live" : "scripted", limits, modelDeadlineMs: 300_000, prices, candidates, candidatePolicy: "controller-only uses the controller model for both controller and staged editor roles; split uses the configured fast model for the editor. Both retain the same production graph.", cells: cells.map((cell) => ({ candidate: cell.candidate.id, caseId: cell.testCase.id, sample: cell.sample })), subscriptionCost: null, pricingPolicy: "Before dispatch reserve UTF-8 request bytes as conservative input tokens plus explicit maximum output. Reservations are never refunded, including failures/retries. Subscription usage is unpriced, with no supported upstream output-token cap; requests, input bytes and trial duration are separately bounded. Free-output evaluation calls reserve their input cost." }, null, 2)}\n`) })
  const native = yield* runSmithCodingCalibrations(directory, candidates, live ? "live" : "scripted", transport, 2)
  const trials = yield* Effect.forEach(native.trials, (trial) => Effect.gen(function* () {
    const candidate = yield* Schema.decodeUnknownEffect(SmithCalibrationCandidate)(trial.candidate)
    const id = `${candidate.id}.${trial.caseId}.${trial.sample}`
    const decoded = Option.flatMap(trial.evidence, Schema.decodeUnknownOption(SmithCodingEvidence))
    const evidence: SmithCodingEvidence = Option.getOrElse(decoded, () => ({ version: "1", candidate: candidate.id, caseId: trial.caseId, sample: trial.sample, transport: live ? "live" : "scripted", driverModel: candidate.driverModel, editorModel: candidate.editorModel, modules: candidate.modules, outerGraphFingerprint: "unavailable-before-activation", resolvedConfig: { status: "unavailable-before-activation" }, versions: { dataset: SMITH_CODING_DATASET_VERSION, eval: "1", controllerPrompt: SMITH_CONTROLLER_PROMPT_VERSION, editorPrompt: SMITH_EDITOR_PROMPT_VERSION, editSchema: SMITH_EDIT_SCHEMA_VERSION, planningPrompt: "smith.planning/1", effect: "4.0.0-rc.118", evaluationProtocol: "4" }, outcome: "boot-failed", error: Option.getOrElse(trial.reason, () => "Native task produced no coding evidence").replaceAll(repositoryRoot, "<efferent>").replaceAll(homedir(), "<home>"), checks: [], diff: [], usage: {}, roleUsage: { controller: {}, editor: {}, escalation: {} }, latencyMs: trial.endedAt - trial.startedAt, parentEvents: [], editorEvents: [], transportRequests: [] }))
    yield* Effect.sync(() => writeFileSync(join(directory, smithEvidenceFilename(candidate.id, trial.caseId, trial.sample)), `${JSON.stringify(evidence, null, 2)}\n`))
    const passed = trial.status === "completed" && trial.evaluations.length > 0 && trial.evaluations.every((assessment) => assessment.status === "scored" && assessment.metrics.every((metric) => metric.kind === "boolean" && metric.value)) && evidence.outcome === "completed" && evidence.checks.every((check) => check.pass)
    console.log(`smith evals: ${id} ${passed ? "passed" : "failed"} (${evidence.latencyMs} ms)`)
    const infrastructureFailure = evidence.outcome === "boot-failed" || (evidence.error !== null && /AuthError|OAuth token|HTTP 401|status 401|HTTP 403|TransportError|network|transport failed|ECONN/.test(evidence.error))
    return { id, evidence, passed, infrastructureFailure }
  }))
  const summary = {
    version: "1", mode: live ? "live" : "scripted", total: cells.length, recordedTrials: trials.length, passed: trials.filter((trial) => trial.passed).length,
    nativeCalibrationsPassed: native.reports.every((report) => report.reviewed && report.failures.length === 0 && report.candidates.length > 0 && report.candidates.every((candidate) => candidate.passed)),
    status: trials.every((trial) => trial.infrastructureFailure) ? "blocked" : live ? "completed" : "scripted-complete",
    infrastructureFailures: trials.filter((trial) => trial.infrastructureFailure).length,
    qualityComparisonAvailable: live && trials.some((trial) => !trial.infrastructureFailure && Object.values(trial.evidence.usage).some((usage) => usage.totalTokens > 0)),
    billedCostUsd: null,
    admission: yield* budget.summary,
    candidates: candidates.map((candidate) => {
      const selected = trials.filter((trial) => trial.evidence.candidate === candidate.id)
      const usage = selected.reduce((sum, trial) => Object.values(trial.evidence.usage).reduce(addUsage, sum), zeroUsage)
      return { id: candidate.id, passed: selected.filter((trial) => trial.passed).length, total: selected.length, infrastructureFailures: selected.filter((trial) => trial.infrastructureFailure).length, latencyMs: selected.reduce((sum, trial) => sum + trial.evidence.latencyMs, 0), usage, failures: selected.filter((trial) => !trial.passed).map((trial) => ({ id: trial.id, category: trial.infrastructureFailure ? "infrastructure" : "acceptance", error: trial.evidence.error, checks: trial.evidence.checks.filter((check) => !check.pass) })) }
    }),
    jev: trials.flatMap((trial) => trial.evidence.parentEvents.filter((event) => JSON.stringify(event).includes("smith.planning"))).map((event) => event),
  }
  yield* Effect.sync(() => writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`))
  console.log(JSON.stringify({ directory: directory.replace(repositoryRoot, "."), total: summary.total, passed: summary.passed, admission: summary.admission }, null, 2))
  return summary.nativeCalibrationsPassed && summary.passed === summary.total ? 0 : 1
})

if (process.argv[1]?.endsWith("smithMatrix.ts")) process.exit(await Effect.runPromise(runSmithMatrix(process.argv.slice(2)).pipe(Effect.scoped)))
