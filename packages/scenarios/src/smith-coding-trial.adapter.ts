import { Clock, Effect, Option, Schema } from "effect"
import { homedir } from "node:os"
import { graphFingerprint } from "@xandreed/runtime"
import { addUsage, SessionLogEvent, Sessions, SettingsStore, TokenUsage, zeroUsage } from "@xandreed/core"
import type { Plugin } from "@xandreed/core"
import { Harness } from "@xandreed/sdk"
import { smithAgent, SMITH_CONTROLLER_PROMPT_VERSION, SMITH_EDIT_SCHEMA_VERSION, SMITH_EDITOR_PROMPT_VERSION, VerificationCheck } from "@xandreed/smith"
import { SMITH_CODING_DATASET_VERSION } from "./smith-coding-cases.entity.js"
import type { SmithCodingCase, SmithCodingTask } from "./smith-coding-cases.entity.js"
import type { SmithCodingEvidence } from "./smith-coding-trial.entity.js"
import { productionVerified, smithTrialPlanningOptions } from "./smith-coding-trial.entity.functions.js"
import { inspectFixture, repositoryRoot, seedFixture } from "./smith-coding-fixture.adapter.js"
import { scriptedSmithTransport } from "./smith-scripted-transport.adapter.js"

export const runSmithCodingTrial = (testCase: SmithCodingCase | SmithCodingTask, candidate: { readonly id: string; readonly driverModel: string; readonly editorModel: string; readonly modules: ReadonlyArray<string> }, sample: number, mode: "scripted" | "live", liveTransport: Option.Option<{ readonly plugin: Plugin; readonly requests: Effect.Effect<ReadonlyArray<unknown>> }> = Option.none()) => Effect.gen(function* () {
  const task = "solution" in testCase ? { id: testCase.id, task: testCase.task, seed: testCase.seed, paths: Object.keys(testCase.solution) } : testCase
  const fixture = yield* seedFixture(testCase, mode === "scripted")
  const scripted = mode === "scripted" ? Option.some(yield* scriptedSmithTransport(task)) : Option.none()
  const transport = Option.orElse(Option.map(scripted, (value) => ({ plugin: value.plugin, requests: value.requests })), () => liveTransport)
  const preset = smithAgent(fixture.dir, () => Effect.succeed(false))
  const config = { ...preset.config, profile: "smith", plugins: [
    ...(preset.config.plugins ?? []).map((entry) => entry.id === "models" ? { ...entry, options: { model: candidate.driverModel, fastModel: candidate.editorModel, fallbackModel: "", inheritPrevious: mode === "live" } }
      : entry.id === "loop" ? { ...entry, options: { driverModel: candidate.driverModel, editorModel: candidate.editorModel, modules: [...candidate.modules], maxModelRequests: 32, maxEditorAttempts: 2, editorMaxSteps: 12, budgetMillis: 300_000 } }
      : entry.id === "planning" && mode === "live" ? { ...entry, options: smithTrialPlanningOptions(candidate.driverModel, candidate.editorModel) }
      : entry.id === "telemetry" ? { ...entry, enabled: false } : entry),
    ...Option.match(transport, { onNone: () => [], onSome: (value) => [{ id: "eval-transport", use: value.plugin.id }] }),
  ] }
  const harness = yield* Harness.make({ workspace: fixture.dir, config, plugins: [...preset.plugins, ...Option.match(transport, { onNone: () => [], onSome: (value) => [value.plugin] })] })
  const graph = yield* harness.graph
  const outerGraphFingerprint = graphFingerprint(graph)
  const graphVersions = Object.fromEntries(graph.nodes.map((node) => [node.plugin.id, node.plugin.version]))
  const session = yield* harness.create()
  const effectiveSettings = yield* session.use(SettingsStore, (store) => store.load)
  const initialRequests = yield* Option.match(transport, { onNone: () => Effect.succeed<ReadonlyArray<unknown>>([]), onSome: (value) => value.requests })
  const started = yield* Clock.currentTimeMillis
  const outcome = yield* Effect.result(session.send(testCase.task))
  const latencyMs = (yield* Clock.currentTimeMillis) - started
  const parentEvents = yield* session.journalHistory
  const editorEvents = yield* session.use(Sessions, (sessions) => sessions.list({ owner: fixture.dir, parent: session.record.id }).pipe(Effect.flatMap((page) => Effect.forEach(page.sessions, (child) => sessions.read({ id: child.header.id, owner: fixture.dir }))), Effect.map((all) => all.flat())))
  const final = yield* inspectFixture(fixture.dir, fixture.seed, task.paths)
  const lastApplied = parentEvents.findLast((event) => event.kind === "smith.receipt" && event.data.status === "applied")?.seq ?? 0
  const verification = yield* Effect.forEach(parentEvents.filter((event) => event.kind === "smith.check" && event.seq > lastApplied), (event) => Schema.decodeUnknownEffect(VerificationCheck)(event.data))
  const verified = productionVerified(verification)
  const productionCheck = { name: "production-verification", pass: verified, stdout: verification.map((check) => `${check.command}\n${check.stdout}`).join("\n"), stderr: verified ? "" : verification.map((check) => check.stderr).join("\n") || "Smith did not record successful direct bun test and bun run check commands after applying edits", exitCode: verified ? 0 : 1 }
  const transportRequests = (yield* Option.match(transport, { onNone: () => Effect.succeed<ReadonlyArray<unknown>>([]), onSome: (value) => value.requests })).slice(initialRequests.length)
  const usageOf = (events: ReadonlyArray<SessionLogEvent>) => Effect.reduce(events.filter((event) => event.kind === "step.usage"), () => ({} as Record<string, TokenUsage>), (all, event) => Schema.decodeUnknownEffect(TokenUsage)(event.data.usage).pipe(Effect.map((value) => ({ ...all, [String(event.data.model)]: addUsage(all[String(event.data.model)] ?? zeroUsage, value) }))))
  const usage = yield* usageOf([...parentEvents, ...editorEvents])
  const escalated = new Set(parentEvents.filter((event) => event.kind === "smith.editor" && event.data.status === "started" && event.data.role === "controller").map((event) => event.data.sessionId))
  const roleUsage = { controller: yield* usageOf(parentEvents), editor: yield* usageOf(editorEvents.filter((event) => !escalated.has(event.session))), escalation: yield* usageOf(editorEvents.filter((event) => escalated.has(event.session))) }
  const safe = (text: string) => text.replaceAll(fixture.dir, "<workspace>").replaceAll(repositoryRoot, "<efferent>").replaceAll(homedir(), "<home>")
  const safeEvents = (events: ReadonlyArray<SessionLogEvent>) => Schema.encodeEffect(Schema.Array(SessionLogEvent))(events).pipe(Effect.map((encoded) => JSON.parse(safe(JSON.stringify(encoded))) as ReadonlyArray<unknown>))
  return {
    version: "1", candidate: candidate.id, caseId: testCase.id, sample, transport: mode, driverModel: candidate.driverModel, editorModel: candidate.editorModel,
    outerGraphFingerprint, resolvedConfig: JSON.parse(safe(JSON.stringify({ config: graph.config, bindings: graph.providers, plugins: graph.nodes.map((node) => ({ id: node.entry.id, use: node.plugin.id, version: node.plugin.version, scope: node.plugin.scope, options: node.options })), settings: effectiveSettings }))), versions: { ...graphVersions, dataset: SMITH_CODING_DATASET_VERSION, eval: "1", controllerPrompt: SMITH_CONTROLLER_PROMPT_VERSION, editorPrompt: SMITH_EDITOR_PROMPT_VERSION, editSchema: SMITH_EDIT_SCHEMA_VERSION, planningPrompt: "smith.planning/1", effect: "4.0.0-rc.118", providerProtocol: "responses-or-chat-completions", evaluationProtocol: "4" },
    modules: [...candidate.modules], outcome: outcome._tag === "Success" ? String(parentEvents.findLast((event) => event.kind === "turn.ended")?.data.reason ?? "partial") : "failed", error: outcome._tag === "Success" ? null : safe(outcome.failure.message), latencyMs, usage, roleUsage,
    checks: [...final.checks, productionCheck].map((check) => ({ ...check, stdout: safe(check.stdout), stderr: safe(check.stderr) })), diff: final.diff,
    parentEvents: yield* safeEvents(parentEvents), editorEvents: yield* safeEvents(editorEvents), transportRequests,
  } satisfies SmithCodingEvidence
})
