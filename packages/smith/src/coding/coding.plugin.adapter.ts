import { LanguageModel } from "effect/ai"
import { Clock, Context, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect"
import {
  ActiveTurnWriter, AgentLoop, AuthStore, Capabilities, ConversationMemory, CurrentModelCallPolicy, defineHostEvent, definePlugin,
  FileSystem, HarnessError, modelRequestDescriptorOf, parseModelSelection, PermissionGrants, resolveModelRequest, SessionEnvironment, Sessions,
  SettingsStore, Shell, StepLoop, ToolRegistry, UserMessage,
} from "@xandreed/core"
import type { AgentMessage, TurnOutcome } from "@xandreed/core"
import { Agent } from "@xandreed/sdk"
import { LanguageModelSelectionLive, ModelTransport } from "@xandreed/plugin-models"
import { EditProposal, EditReceipt, SMITH_EDIT_SCHEMA_VERSION, VerificationCheck, WorkOrder, WorkOrderId } from "./edit.entity.js"
import { SmithEditing, SmithEditor, SmithFiles } from "./editing.port.js"
import { SelectedSmithModules, SmithEffectModule } from "./effect-modules.adapter.js"
import { SmithPlanning } from "./planning.port.js"
import { makeWorkspace } from "./workspace.adapter.js"

export const SmithCodingConfig = Schema.Struct({
  readOnly: Schema.Boolean,
  driverModel: Schema.String,
  editorModel: Schema.String,
  modules: Schema.Array(SmithEffectModule),
  planningMode: Schema.Literals(["auto", "direct", "plan"]),
  maxModelRequests: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).annotate({ description: "Shared model steps across controller/editor; transport retries below LanguageModel remain provider-owned" }),
  editorMaxSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  maxEditorAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  budgetMillis: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 3_600_000 })),
  budgetTokens: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 256_000 })).annotate({ description: "Shared cumulative input/output tokens across controller and editor for one user request" }),
  contextTokens: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 256_000 })).annotate({ description: "Per-request conversation context window; bounded by the shared token budget" }),
  maxOutputTokens: Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 16_384 })),
})
export const smithCodingDefaults = { readOnly: false, driverModel: "", editorModel: "", modules: [], planningMode: "auto" as const, maxModelRequests: 50, editorMaxSteps: 12, maxEditorAttempts: 2, budgetMillis: 900_000, budgetTokens: 256_000, contextTokens: 64_000, maxOutputTokens: 4096 }
const failure = (code: string, message: string) => new HarnessError({ code: `smith.${code}`, message })
const PlanningEvent = defineHostEvent("smith.planning", Schema.Struct({ mode: Schema.Literals(["direct", "plan"]), reason: Schema.String, outcome: Schema.Literals(["selected", "unavailable", "explicit"]), promptId: Schema.String, promptVersion: Schema.String }))
const EditorEvent = defineHostEvent("smith.editor", Schema.Struct({ workOrderId: Schema.String, sessionId: Schema.String, status: Schema.Literals(["started", "completed", "failed"]), attempt: Schema.Int, role: Schema.Literals(["editor", "controller"]), model: Schema.String, failure: Schema.OptionFromNullOr(Schema.String) }))
const ProposalEvent = defineHostEvent("smith.proposal", EditProposal)
const ReceiptEvent = defineHostEvent("smith.receipt", EditReceipt)
const CheckEvent = defineHostEvent("smith.check", VerificationCheck)
const ContextEvent = defineHostEvent("smith.context", Schema.Struct({ modules: Schema.Array(SmithEffectModule), readOnly: Schema.Boolean, budgetTokens: Schema.Int, contextTokens: Schema.Int, controllerPromptVersion: Schema.String, editorPromptVersion: Schema.String, editSchemaVersion: Schema.String }))
const BudgetEvent = defineHostEvent("smith.budget", Schema.Struct({ requests: Schema.Int, requestUnit: Schema.Literal("model-step"), usedTokens: Schema.Number, limitTokens: Schema.Int }))
const ModelEvent = defineHostEvent("smith.models", Schema.Struct({ driver: Schema.String, editor: Schema.String, modules: Schema.Array(SmithEffectModule), maxModelRequests: Schema.Int }))
export const SMITH_CONTROLLER_PROMPT_VERSION = "2"
export const SMITH_EDITOR_PROMPT_VERSION = "1"
const CHECK_SYSTEM = `You are Smith, the engineering controller. Respond directly to greetings, conversation and questions you can answer from the existing context. For a simple greeting, reply with one short sentence. Describe capabilities only when asked. Honor the user's requested response format. Use workspace tools when the user's request needs workspace facts or source changes. Before changing source, inspect the relevant files and applicable AGENTS.md/CLAUDE.md instructions. Resolve facts with read_file, glob, grep and ls. For changes, delegate a focused work order to the editor, review the returned proposal, apply it, and verify with relevant project checks. The editor cannot change the real workspace. Fix weak proposals by delegating a correction. Preserve unrelated changes. Ask only for decisions that materially block the task. Give brief progress and a concise final result with actual verification outcomes. Never claim an unrun check passed. An available tool or skill is optional; use it only when it helps fulfill the current request.`
const INTERNAL_PLAN_SYSTEM = `Internal planning policy: follow the user's current request. If the request needs implementation work, inspect the relevant files and form a concise internal plan before editing, then carry out the requested work immediately. Update the plan when evidence changes the approach. This policy does not create an inspection task or replace the user's message. Answer greetings and ordinary conversation directly. Keep internal planning out of the final answer unless the user requested a plan.`
const EDITOR_SYSTEM = `You are Smith's focused editor. Inspect the files and applicable workspace instructions. Follow the work order and enabled modules. read_file shows staged content. write_file, edit_file and delete_file stage changes; they never modify the real workspace. Change only paths in the work order. Finish with submit_edits, including a brief summary. You cannot run commands, delegate work or apply proposals. Make the smallest complete implementation, preserving unrelated code.`

/** Captures the externally configured mechanisms; this host owns policy, never its own loop. */
export const smithCodingPlugin = definePlugin({
  id: "@xandreed/smith/coding", version: "1.0.0", config: SmithCodingConfig, defaults: smithCodingDefaults,
  requires: [LanguageModel.LanguageModel, AuthStore, SettingsStore, Sessions, SessionEnvironment, Capabilities, ConversationMemory, ToolRegistry, StepLoop, FileSystem, Shell],
  optional: [SmithPlanning, ModelTransport, CurrentModelCallPolicy], provides: [AgentLoop],
  layer: (config) => Layer.effect(AgentLoop, Effect.gen(function* () {
    const captured = yield* Effect.context<AuthStore>()
    const sessions = yield* Sessions
    const { workspace } = yield* SessionEnvironment
    const shell = yield* Shell
    const settings = yield* SettingsStore
    const baseModel = yield* LanguageModel.LanguageModel
    const planner = yield* Effect.serviceOption(SmithPlanning)
    const io = yield* makeWorkspace(workspace)
    const contextTokens = Math.min(config.contextTokens, config.budgetTokens)
    const agent = yield* Agent.define({ plugins: [], services: captured, workspace, cacheKeyPrefix: "smith", budgetTokens: contextTokens })
    return AgentLoop.of({ run: (input) => Effect.scoped(Effect.gen(function* () {
      const writer = yield* Option.match(Context.getOption(input.services, ActiveTurnWriter), { onNone: () => Effect.fail(failure("turn", "Smith requires the Harness's admitted turn writer")), onSome: (active) => Effect.succeed(active.writer) })
      const loaded = yield* settings.load.pipe(Effect.mapError((error) => failure("models", error.message)))
      const selected = (text: string, defaultModel: LanguageModel.LanguageModel) => text.length === 0 ? resolveModelRequest(defaultModel) : Option.match(parseModelSelection(text), {
        onNone: () => Effect.fail(failure("models", `Invalid model selection ${text}`)),
        onSome: (selection) => Layer.build(LanguageModelSelectionLive(selection, Option.flatMap(loaded.fallbackModel, parseModelSelection))).pipe(Effect.provide(captured), Effect.map((context) => Context.get(context, LanguageModel.LanguageModel))),
      })
      const driver = yield* selected(config.driverModel, baseModel)
      const editor = yield* selected(config.editorModel || Option.getOrElse(loaded.fastModel, () => ""), driver)
      const requests = yield* Ref.make(0)
      const usedTokens = yield* Ref.make(0)
      const editorGate = yield* Semaphore.make(1)
      const reserve = Ref.modify(requests, (used) => [used < config.maxModelRequests, used < config.maxModelRequests ? used + 1 : used] as const).pipe(Effect.flatMap((allowed) => allowed ? Effect.void : Effect.fail(failure("budget", `The ${config.maxModelRequests}-request model budget is exhausted`))))
      const label = (model: LanguageModel.LanguageModel) => modelRequestDescriptorOf(model).pipe(Effect.map((description) => Option.match(description, { onNone: () => "custom", onSome: (value) => `${value.provider}:${value.model}` })))
      const driverLabel = yield* label(driver)
      const editorLabel = yield* label(editor)
      const capturedPolicy = yield* CurrentModelCallPolicy
      const outputCap = Math.min(config.maxOutputTokens, Option.getOrElse(Option.flatMap(capturedPolicy, (policy) => Option.fromNullishOr(policy.maxOutputTokens)), () => config.maxOutputTokens))
      const observeBudget = (events: import("@xandreed/core").TurnEventsService) => Effect.gen(function* () {
        yield* events.subscribe((event) => event._tag === "context.built" ? Option.some(event) : Option.none(), (event) => Ref.get(usedTokens).pipe(Effect.flatMap((used) => used + event.estimatedTokens + event.reservedTokens + outputCap > config.budgetTokens
          ? Effect.fail(failure("tokens", `The shared ${config.budgetTokens}-token budget cannot admit this request (${used} used, ${event.estimatedTokens + event.reservedTokens + outputCap} reserved)`)) : Effect.void)))
        yield* events.subscribe((event) => event._tag === "assistant.message" ? Option.some(event) : Option.none(), (event) => Ref.update(usedTokens, (used) => used + event.usage.totalTokens))
      })
      const proposals = yield* Ref.make(new Map<string, EditProposal>())
      const receipts = yield* Ref.make(new Map<string, import("./edit.entity.js").EditReceipt>())
      const editingRef = yield* Ref.make(Option.none<SmithEditing["Service"]>())
      const editingService = Ref.get(editingRef).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.fail(failure("editing", "The controller's editing tools are not initialized")), onSome: Effect.succeed })))
      const editingFacade = SmithEditing.of({ delegate: (order) => editingService.pipe(Effect.flatMap((editing) => editing.delegate(order))), apply: (id) => editingService.pipe(Effect.flatMap((editing) => editing.apply(id))), verify: (command) => editingService.pipe(Effect.flatMap((editing) => editing.verify(command))) })
      const grants = (values: ReadonlyArray<string>) => PermissionGrants.of({ grants: Effect.succeed(new Set(values)) })
      const servicesFor = (model: LanguageModel.LanguageModel, roleGrants: ReadonlyArray<string>, effort: typeof loaded.reasoningEffort) => Context.add(captured, LanguageModel.LanguageModel, model).pipe(
        Context.add(PermissionGrants, grants(roleGrants)), Context.add(SelectedSmithModules, config.modules),
        Context.add(CurrentModelCallPolicy, Option.some({ effort: Option.getOrElse(effort, () => Option.getOrElse(Option.map(capturedPolicy, (policy) => policy.effort), () => "medium" as const)), maxOutputTokens: outputCap })),
      )
      const driverServices = servicesFor(driver, config.readOnly ? [] : ["smith.controller", "smith.verify"], loaded.reasoningEffort).pipe(Context.add(SmithFiles, io.files), Context.add(SmithEditing, editingFacade))
      const editorServices = servicesFor(editor, ["smith.editor"], loaded.fastReasoningEffort)
      const runController = agent.turn({ turn: writer, services: driverServices, system: `${input.system}\n\n${CHECK_SYSTEM}${config.readOnly ? "\nWorkspace access is read-only. For requests needing workspace work, inspect and propose changes; edits and commands are unavailable." : ""}`, steering: input.steering }, (turn) => Effect.gen(function* () {
        yield* ModelEvent.publish(turn.events, { driver: driverLabel, editor: editorLabel, modules: config.modules, maxModelRequests: config.maxModelRequests })
        yield* ContextEvent.publish(turn.events, { modules: config.modules, readOnly: config.readOnly, budgetTokens: config.budgetTokens, contextTokens, controllerPromptVersion: SMITH_CONTROLLER_PROMPT_VERSION, editorPromptVersion: SMITH_EDITOR_PROMPT_VERSION, editSchemaVersion: SMITH_EDIT_SCHEMA_VERSION })
        yield* observeBudget(turn.events)
        yield* turn.events.subscribe((event) => event._tag === "assistant.delta" ? Option.some(event) : Option.none(), (event) => input.transient({ name: "native.delta", runId: input.runId, data: { event, sourceSession: writer.admitted.session.id } }))
        const history = yield* turn.memory.entries.pipe(Effect.map((entries): ReadonlyArray<AgentMessage> => entries.flatMap((entry): ReadonlyArray<AgentMessage> => entry.body._tag === "Message" ? [entry.body.message] : entry.body._tag === "TurnStarted" ? [{ role: "user", content: entry.body.userMessage.text }] : entry.body._tag === "TurnEnded" && Option.isSome(entry.body.reply) ? [{ role: "assistant", content: [{ type: "text", text: entry.body.reply.value }] }] : [])))
        const decision = config.planningMode !== "auto" ? { mode: config.planningMode, reason: "Explicit planning policy", outcome: "explicit" as const }
          : yield* Option.match(planner, {
            onNone: () => Effect.succeed({ mode: "plan" as const, reason: "Planning adapter unavailable", outcome: "unavailable" as const }),
            onSome: (planning) => planning.decide({ userMessage: input.userMessage, history }).pipe(Effect.map((value) => ({ ...value, outcome: "selected" as const })), Effect.catch((error) => Effect.succeed({ mode: "plan" as const, reason: error.message, outcome: "unavailable" as const }))),
          })
        yield* PlanningEvent.publish(turn.events, { ...decision, promptId: "smith.planning", promptVersion: "1" })
        yield* turn.tools.select(input.userMessage)
        yield* turn.tools.activate(config.readOnly ? ["smith.read"] : ["smith.read", "smith.controller", "smith.verify"])
        const delegate = (order: { readonly objective: string; readonly paths: ReadonlyArray<string> }) => editorGate.withPermits(1)(Effect.gen(function* () {
          const workOrder = new WorkOrder({ id: WorkOrderId.make(crypto.randomUUID()), ...order })
          yield* Effect.forEach(order.paths, (path) => io.pathOf(path, true), { discard: true })
          const instructions = yield* io.instructions(order.paths)
          const result = yield* Effect.reduce(Array.from({ length: config.maxEditorAttempts + 1 }, (_, index) => index), () => ({ attempt: 0, proposal: Option.none<EditProposal>() }), (state) => Option.isSome(state.proposal) ? Effect.succeed(state) : Effect.gen(function* () {
              const escalated = state.attempt === config.maxEditorAttempts
              const chosenModel = escalated ? driver : editor
              const role = escalated ? "controller" as const : "editor" as const
              const overlay = yield* io.overlay(workOrder)
              const child = yield* sessions.fork(writer.admitted.session, { origin: "smith-editor", inherit: false, meta: { workOrderId: workOrder.id } }).pipe(Effect.mapError((error) => failure("editor.session", error.message)))
              const childRunId = crypto.randomUUID()
              yield* EditorEvent.publish(turn.events, { workOrderId: workOrder.id, sessionId: child.header.id, status: "started", attempt: state.attempt + 1, role, model: escalated ? driverLabel : editorLabel, failure: Option.none() })
              const outcome = yield* Effect.result(agent.turn({
                turn: { session: { id: child.header.id, owner: writer.admitted.session.owner }, userMessage: new UserMessage({ text: `${order.objective}\n\nOriginal user request:\n${input.userMessage.text.slice(0, 12_000)}\n\nAllowed paths: ${order.paths.join(", ")}\n${state.attempt === 0 ? "" : "The previous editor did not submit a complete proposal. Submit the actual changes."}\n\n${instructions}` }), runId: childRunId },
                services: Context.add(escalated ? servicesFor(driver, ["smith.editor"], loaded.reasoningEffort) : editorServices, SmithFiles, overlay.files).pipe(Context.add(SmithEditor, overlay.editor)), system: EDITOR_SYSTEM,
              }, (editorTurn) => Effect.gen(function* () {
                yield* editorTurn.events.subscribe((event) => event._tag === "assistant.delta" ? Option.some(event) : Option.none(), (event) => input.transient({ name: "native.delta", runId: childRunId, data: { event, sourceSession: child.header.id } }))
                yield* observeBudget(editorTurn.events)
                yield* editorTurn.tools.select(editorTurn.userMessage)
                yield* editorTurn.tools.activate(["smith.read", "smith.editor"])
                const result = yield* editorTurn.run({ model: () => reserve.pipe(Effect.as(Option.some({ model: chosenModel, variant: Option.none<string>() }))), limits: { maxSteps: config.editorMaxSteps, toolConcurrency: 4, streaming: true, requireCompletion: true }, completion: () => overlay.proposal.pipe(Effect.map((proposal) => ({ complete: Option.isSome(proposal), awaiting: [], facts: { submitted: Option.isSome(proposal) } }))) })
                return { outcome: result.outcome, reply: Option.some(result.text) } satisfies TurnOutcome
              })))
              const proposal = outcome._tag === "Success" ? yield* overlay.proposal : Option.none<EditProposal>()
              yield* EditorEvent.publish(turn.events, { workOrderId: workOrder.id, sessionId: child.header.id, status: Option.isSome(proposal) ? "completed" : "failed", attempt: state.attempt + 1, role, model: escalated ? driverLabel : editorLabel, failure: outcome._tag === "Failure" ? Option.some(outcome.failure.message) : Option.isNone(proposal) ? Option.some("The editor did not submit a complete proposal") : Option.none() })
              if (outcome._tag === "Failure" && outcome.failure.code === "smith.budget") return yield* Effect.fail(outcome.failure)
              return { attempt: state.attempt + 1, proposal }
            }))
          const proposal = yield* Option.match(result.proposal, { onNone: () => Effect.fail(failure("editor.incomplete", "The editor exhausted its attempts without submitting changes")), onSome: Effect.succeed })
          yield* Ref.update(proposals, (all) => new Map([...all, [proposal.id, proposal]]))
          yield* ProposalEvent.publish(turn.events, proposal)
          return proposal
        }))
        const editing = SmithEditing.of({
          delegate,
          apply: (proposalId) => Ref.get(receipts).pipe(Effect.flatMap((known) => Option.match(Option.fromNullishOr(known.get(proposalId)), { onSome: Effect.succeed, onNone: () => Ref.get(proposals).pipe(Effect.flatMap((all) => Option.match(Option.fromNullishOr(all.get(proposalId)), { onNone: () => Effect.fail(failure("proposal.missing", `No submitted proposal ${proposalId} belongs to this turn`)), onSome: (proposal) => turn.write(io.apply(proposal)).pipe(Effect.tap((receipt) => Ref.update(receipts, (values) => new Map([...values, [proposalId, receipt]]))), Effect.tap((receipt) => ReceiptEvent.publish(turn.events, receipt))) }))) }))),
          verify: (command) => turn.flush.pipe(Effect.andThen(shell.exec(command, { cwd: workspace, timeoutMs: Math.min(120_000, config.budgetMillis) })), Effect.map((check) => ({ command, ...check })), Effect.mapError((error) => error instanceof HarnessError ? error : failure("verify", error.message)), Effect.tap((check) => CheckEvent.publish(turn.events, check))),
        })
        yield* Ref.set(editingRef, Option.some(editing))
        const result = yield* turn.run({ model: () => reserve.pipe(Effect.as(Option.some({ model: driver, variant: Option.none<string>() }))), step: () => Effect.succeed({ context: decision.mode === "plan" ? Option.some(INTERNAL_PLAN_SYSTEM) : Option.none(), toolChoice: Option.none() }), stepContext: "system", limits: { maxSteps: config.maxModelRequests, toolConcurrency: 4, streaming: true } }).pipe(Effect.provideService(SmithEditing, editing), Effect.provideService(SmithFiles, io.files))
        yield* BudgetEvent.publish(turn.events, { requests: yield* Ref.get(requests), requestUnit: "model-step", usedTokens: yield* Ref.get(usedTokens), limitTokens: config.budgetTokens })
        return { outcome: result.outcome, reply: Option.some(result.text || (result.outcome === "partial" ? `Stopped before completion (${result.reason}); unapplied editor proposals have not changed the workspace.` : "Completed")) }
      }))
      const started = yield* Clock.currentTimeMillis
      return yield* runController.pipe(Effect.timeoutOption(config.budgetMillis), Effect.flatMap(Option.match({
        onNone: () => Effect.fail(failure("deadline", `The coding deadline elapsed after ${config.budgetMillis} ms`)),
        onSome: (outcome) => Effect.succeed({ text: Option.getOrElse(outcome.reply, () => ""), outcome: outcome.outcome === "completed" ? "completed" as const : "partial" as const }),
      })), Effect.withSpan("smith.coding", { attributes: { "smith.driver": driverLabel, "smith.editor": editorLabel, "smith.started": started } }))
    })) })
  })),
})
