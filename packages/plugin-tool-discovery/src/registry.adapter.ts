import { Tool, Toolkit } from "effect/ai"
import { Cause, Clock, Context, Effect, Exit, Match, Option, Ref, Result, Schema, Semaphore, SynchronizedRef } from "effect"
import {
  ActionPolicy,
  activationsOf,
  attachmentsOf,
  CandidateId,
  canonicalJson,
  PermissionGrants,
  catalogOf,
  CurrentAgentStep,
  CurrentAgentRun,
  CurrentToolInvocation,
  DecisionId,
  defineCapability,
  defineTool,
  elideMediaData,
  Failure,
  fingerprintOf,
  HarnessError,
  IntentMatcher,
  InvocationId,
  isHarnessError,
  isTurnError,
  mediaSlotsOf,
  messagesOf,
  recordDecision,
  replayableContext,
  resolveCapabilities,
  RunContext,
  ToolCallId,
  ToolInterceptor,
  ToolInterceptOutcome,
} from "@xandreed/core"
import { CurrentToolResultReceipt, toolInterceptError, withToolResultReceiptGuard } from "@xandreed/core/internal"
import { afterToolIntercept, beforeToolIntercept, interceptedToolkit, toolInterceptBoundary, toolInterceptMutableJson, toolInterceptSnapshot } from "./tool-interceptor.adapter.js"
import type { ToolInterceptCapture } from "./tool-interceptor.adapter.js"
import { ToolPolicy } from "./tool-policy.entity.js"
import { admitTool, breakerOf, concurrencyMessage, emptyToolAdmission, runCallLimitMessage, settleToolAdmission, trippedMessage } from "./tool-policy.entity.functions.js"
import type {
  ActivationSource,
  CapabilityCatalog,
  Capability,
  DecisionRecord,
  DigestTask,
  Media,
  MediaSlot,
  MemorySession,
  RegisteredTool,
  RunTools,
  SkillDefinition,
  SkillMatch,
  ToolRefusalReason,
  ToolView,
  ToolViews,
  ToolInterceptAudit,
  ToolInterceptIdentity,
  ToolResultInterception,
  BeforeToolDecision,
  TurnError,
  UserMessage,
} from "@xandreed/core"

export interface DiscoveryConfig {
  /** Granted permissions when the turn's services carry no PermissionGrants. */
  readonly grants: ReadonlyArray<string>
  readonly loadSkill: boolean
  readonly maxCallsPerRun: number
  readonly maxSkillLoadsPerRun: number
  readonly readConcurrency: number
  readonly matcherTimeoutMs: number
  readonly catalogVersion: string
  readonly toolPolicy?: Readonly<Record<string, ToolPolicy>>
}

// Toolkit forks handlers into child fibers: logical ancestry must survive that fork.
// Captured opener services never replace the ancestry of the actual caller.
const HoldingToolGates = Context.Reference<boolean>("@xandreed/plugin-tool-discovery/HoldingToolGates", { defaultValue: () => false })

const failure = (error: string, message: string) => ({ error, message })
const firstLine = (text: string): string => text.split("\n", 1)[0] ?? ""
const harness = (code: string, message: string) => new HarnessError({ code, message })

/**
 * The codes an activation is refused with (an unknown skill, a permission not granted), each with the name
 * `load_skill` returns it to the model under; the code stays the host's. Any other failure (the store's) is not a refusal.
 */
const refusalNames: ReadonlyMap<string, string> = new Map([["skills.unknown", "UnknownSkill"], ["capability.forbidden", "PermissionDenied"]])
/** A refusal of an activation as the model reads it: its name and the refusal's message. */
const refusalOf = (error: TurnError): Option.Option<Failure> =>
  isHarnessError(error) ? Option.map(Option.fromNullishOr(refusalNames.get(error.code)), (name) => failure(name, error.message)) : Option.none()
const isRefusal = (error: TurnError): boolean => Option.isSome(refusalOf(error))

const LoadSkill = Tool.make("load_skill", {
  description: "Load one or more skills from the catalogue: returns their instructions and makes their tools available from the next step. Load a skill before doing work it covers.",
  parameters: Schema.Struct({ skills: Schema.Array(Schema.String) }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

const ReadSkillReference = Tool.make("read_skill_reference", {
  description: "Read one reference document listed by a loaded skill.",
  parameters: Schema.Struct({ skill: Schema.String, reference: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

const rawText = (encoded: unknown): string => typeof encoded === "string" ? encoded : canonicalJson(encoded)

/**
 * The images a result sends: the ones the view's selector picks, among
 * those the encoded result holds (`mediaSlotsOf`); every one without a
 * selector. Memory checks them when it records the result.
 */
const selectedSlots = (encoded: unknown, selected: Option.Option<ReadonlyArray<Media>>): ReadonlyArray<MediaSlot> => {
  const slots = mediaSlotsOf(encoded)
  return Option.match(selected, {
    onNone: () => slots,
    onSome: (media) => {
      const wanted = new Set(media.map((image) => String(image.fingerprint)))
      return slots.filter((slot) => wanted.has(String(slot.fingerprint)))
    },
  })
}

/** Tool result schemas are context-free by contract (they cross the wire). */
const contextFree = (schema: Schema.Top): Schema.Codec<unknown, unknown> => schema as Schema.Codec<unknown, unknown>

/** The text a load_skill call returns (tier 2) — also used for matcher-seeded skills. */
export const skillInstructions = (skills: ReadonlyArray<SkillDefinition>, tools: ReadonlyArray<string>): string =>
  skills.map((skill) => [
    `## ${skill.id}`,
    skill.instructions.length > 0 ? skill.instructions : skill.summary,
    skill.tools.length === 0 ? "" : `Tools: ${skill.tools.join(", ")}`,
    skill.references.length === 0 ? "" : `References (read_skill_reference): ${skill.references.map((reference) => `${reference.id} — ${reference.title}`).join("; ")}`,
  ].filter((line) => line.length > 0).join("\n")).join("\n\n") + (tools.length === 0 ? "" : `\n\nNow available: ${tools.join(", ")}`)

/** Tier 1: the catalogue line per loadable skill. */
export const catalogText = (skills: ReadonlyArray<SkillDefinition>): Option.Option<string> => {
  const loadable = skills.filter((skill) => !skill.always)
  return loadable.length === 0 ? Option.none() : Option.some([
    "## Skills (call load_skill before doing work one covers; its tools become available next step)",
    ...loadable.map((skill) => `- ${skill.id}: ${skill.summary}`),
  ].join("\n"))
}

/**
 * The registry over every capability. Built once; each turn opens it
 * where its services are, which the handlers then run with: the RunContext
 * (events, memory), the services each tool declares (all there, or the open
 * fails with `requires.missing`), and the optional IntentMatcher,
 * PermissionGrants and ActionPolicy of that turn. Every call gets its invocation id first; a call
 * refused before its handler runs (an inactive tool, a missing permission,
 * a denial, a call limit) publishes `tool.refused` and fails with the
 * refusal, which the model reads as the call's result.
 */
export const makeRegistry = Effect.fnUntraced(function* (config: DiscoveryConfig, capabilities: ReadonlyArray<Capability>) {
  const policies = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, ToolPolicy))(config.toolPolicy ?? {}).pipe(
    Effect.mapError((cause) => new HarnessError({ code: "config.options", message: "Tool policy limits are invalid", cause })),
  )
  // Tier 3 exists only when some skill ships references; otherwise its schema is dead weight.
  const hasReferences = capabilities.some((capability) => capability.skills.some((skill) => skill.references.length > 0))
  const own: ReadonlyArray<RegisteredTool> = config.loadSkill ? [
    defineTool({ tool: LoadSkill, handler: () => Effect.die("bound per run"), annotations: { readOnly: true, pinned: true } }),
    ...(hasReferences ? [defineTool({ tool: ReadSkillReference, handler: () => Effect.die("bound per run"), annotations: { readOnly: true } })] : []),
  ] : []
  const registered = [...capabilities.flatMap((capability) => capability.tools), ...own]
  const unknownPolicies = Object.keys(policies).filter((name) => !registered.some((entry) => entry.tool.name === name))
  if (unknownPolicies.length > 0) return yield* Effect.fail(harness("config.options", `Tool policy names unregistered tools: ${unknownPolicies.join(", ")}`))
  // Constructed once for this registry/agent, shared by every turn's open tools.
  const toolGates = new Map(yield* Effect.forEach(Object.entries(policies), ([name, policy]) =>
    policy.concurrency === undefined ? Effect.succeed([name, Option.none<Semaphore.Semaphore>()] as const)
      : Semaphore.make(policy.concurrency).pipe(Effect.map((gate) => [name, Option.some(gate)] as const)), { concurrency: 1 }))
  const duplicateTool = registered.find((entry, index) => registered.findIndex((other) => other.tool.name === entry.tool.name) !== index)
  if (duplicateTool !== undefined) return yield* Effect.fail(harness("tools.duplicate", `Two capabilities define the tool ${duplicateTool.tool.name}`))
  const skills = capabilities.flatMap((capability) => capability.skills)
  const duplicateSkill = skills.find((skill, index) => skills.findIndex((other) => other.id === skill.id) !== index)
  if (duplicateSkill !== undefined) return yield* Effect.fail(harness("skills.duplicate", `Two capabilities define the skill ${duplicateSkill.id}`))
  const unknownTool = skills.flatMap((skill) => skill.tools.filter((tool) => !registered.some((entry) => entry.tool.name === tool)).map((tool) => `${skill.id} → ${tool}`))
  if (unknownTool.length > 0) return yield* Effect.fail(harness("skills.tools", `Skills reference unregistered tools: ${unknownTool.join(", ")}`))
  const catalog: CapabilityCatalog = yield* catalogOf(config.catalogVersion, [...capabilities, defineCapability({ id: "tool-discovery", version: "1", tools: own })])
  const byName = new Map(registered.map((entry) => [entry.tool.name, entry] as const))
  const skillsForTool = (tool: string) => skills.filter((skill) => skill.tools.includes(tool)).map((skill) => skill.id)
  const viewsFor = (services: Context.Context<never>): ToolViews => {
    const decoded = (name: string, encoded: unknown, params: unknown): Effect.Effect<Option.Option<{ readonly entry: RegisteredTool; readonly result: unknown; readonly params: unknown }>> =>
      Option.match(Option.fromNullishOr(byName.get(name)), {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (entry) => Effect.gen(function* () {
          const input = yield* Schema.isSchema(entry.tool.parametersSchema) ? Schema.decodeUnknownEffect(contextFree(entry.tool.parametersSchema))(params) : Effect.succeed(params)
          const result = yield* Schema.decodeUnknownEffect(contextFree(entry.tool.successSchema))(encoded)
          return Option.some({ entry, result, params: input })
        }).pipe(
          Effect.provide(services),
          Effect.catch((error) => isTurnError(error) ? Effect.die(error) : Effect.logDebug(`a ${name} result does not decode against the tool's schema; it is not digested`, error).pipe(Effect.as(Option.none()))),
        ),
      })

    return {
      view: (name, encoded, params, isError) => {
        const entry = byName.get(name)
        const pinned = entry?.annotations.pinned ?? false
        // The raw view never carries an image's base64 as text: the images go as images (a failed call's as none).
        const slots = isError ? [] : selectedSlots(encoded, Option.none())
        const raw: ToolView = {
          text: rawText(elideMediaData(encoded)), version: "raw", subjects: [], artifacts: [], pinned,
          ...(slots.length === 0 ? {} : { media: slots }),
        }
        if (entry === undefined || isError || Option.isNone(entry.view)) return Effect.succeed(raw)
        const view = entry.view.value
        return decoded(name, encoded, params).pipe(
          Effect.map((found): ToolView => Option.match(found, { onNone: () => raw, onSome: ({ result, params }) => {
            const media = selectedSlots(encoded, Option.map(view.media, (select) => select(result, params)))
            return {
              text: view.render(result, params), version: view.version, subjects: view.subjects(result, params),
              artifacts: view.artifacts(result, params), pinned,
              ...(media.length === 0 ? {} : { media }),
            }
          } })),
        )
      },
      compact: (name, encoded, params) => {
        const view = Option.flatMap(Option.fromNullishOr(byName.get(name)), (entry) => entry.view)
        const compact = Option.flatMap(view, (value) => value.compact)
        const entry = byName.get(name)
        return Option.isNone(compact) || entry === undefined ? Effect.succeed(Option.none())
          : decoded(name, encoded, params).pipe(
            Effect.map((found) => Option.map(found, ({ result, params }) => compact.value(result, params))),
          )
      },
      digest: (name, encoded, params, userMessage) => decoded(name, encoded, params).pipe(Effect.map((found) => Option.flatMap(found, ({ entry, result, params }) =>
        Option.flatMap(Option.flatMap(entry.view, (view) => Option.map(view.digest, (digest) => ({ view, digest }))), ({ view, digest }): Option.Option<DigestTask> => {
          const source = view.render(result, params)
          const base = { tool: name, version: digest.version, instructions: digest.instructions, userMessage, source }
          if (digest._tag === "Summarize") {
            const preserve = digest.preserve(result)
            return Option.some({
              ...base, mode: "summarize", items: [], preserve,
              apply: (outcome) => Option.filter(outcome.summary, (summary) => summary.trim().length > 0 && preserve.every((id) => summary.includes(id))),
            })
          }
          const items = digest.items(result)
          return items.length === 0 ? Option.none() : Option.some({
            ...base, mode: "select", items, preserve: [],
            apply: (outcome) => {
              const keep = outcome.keep.filter((key) => items.some((item) => item.key === key))
              return keep.length === 0 ? Option.none() : Option.some(digest.render(result, params, keep))
            },
          })
        })))),
    }
  }
  const views = viewsFor(Context.omit(CurrentToolResultReceipt)(replayableContext(yield* Effect.context<never>())))

  const open = (session: MemorySession) => Effect.gen(function* () {
    const run = yield* RunContext
    // What the handlers run with: everything where the tools are opened, but the span there:
    // a call's spans nest under the step that makes it, a handler's under its `tool.*` span.
    const runServices = Context.omit(CurrentAgentRun, CurrentAgentStep, CurrentToolResultReceipt, HoldingToolGates)(replayableContext(yield* Effect.context<never>()))
    // Every service a tool declares is here, or the run does not open: no handler finds one missing mid-turn.
    const missing = registered.flatMap((entry) => {
      const absent = (entry.requires ?? []).filter((key) => !runServices.mapUnsafe.has(key))
      return absent.length === 0 ? [] : [`${entry.tool.name} requires ${absent.join(", ")}`]
    })
    if (missing.length > 0) return yield* Effect.fail(harness("requires.missing", missing.join("; ")))
    const matcher = yield* Effect.serviceOption(IntentMatcher)
    const policy = yield* Effect.serviceOption(ActionPolicy)
    const interceptor = yield* Effect.serviceOption(ToolInterceptor)
    const grants = yield* Option.match(yield* Effect.serviceOption(PermissionGrants), {
      onNone: () => Effect.succeed<ReadonlySet<string>>(new Set(config.grants)),
      onSome: (service) => service.grants,
    })
    // The skills and tools activated so far, each in activation order: one value, so one activation moves both.
    const activated = yield* SynchronizedRef.make(activationsOf(yield* session.entries))
    const admission = yield* Ref.make(emptyToolAdmission)
    const skillLoads = yield* Ref.make(0)
    const invocation = yield* Ref.make(0)
    // Each matcher decision, and each load_skill exchange seeded from one, takes the next number of the run.
    const decisions = yield* Ref.make(0)
    const seeds = yield* Ref.make(0)
    const readLane = yield* Semaphore.make(config.readConcurrency)
    const turnstile = yield* Semaphore.make(1)
    const pendingWriters = yield* Ref.make(0)

    /**
     * Activate skills in one step: what is new is computed from the held set,
     * recorded, and only then applied, under the set's lock, so concurrent
     * activations (the load_skill calls of one step) each start from the
     * other's tools. Returns the tools this activation added and the active
     * tools after it.
     */
    const activation = (requested: ReadonlyArray<string>, source: ActivationSource) => Effect.gen(function* () {
      const unknown = requested.filter((id) => !skills.some((skill) => skill.id === id))
      if (unknown.length > 0) return yield* Effect.fail(harness("skills.unknown", `Unknown skill${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}; load_skill takes the skills the catalogue lists`))
      const resolved = yield* resolveCapabilities(catalog, { recipes: [...requested], tools: [] }, grants)
      const step = yield* SynchronizedRef.modifyEffect(activated, (held) => {
        const freshTools = resolved.tools.map((tool) => tool.id).filter((tool) => !held.tools.includes(tool))
        const freshSkills = [...new Set(requested)].filter((id) => !held.skills.includes(id))
        const next = { skills: [...held.skills, ...freshSkills], tools: [...held.tools, ...freshTools] }
        return freshTools.length === 0 && freshSkills.length === 0 ? Effect.succeed([{ skills: freshSkills, tools: freshTools, active: held.tools }, held] as const)
          : session.record([{ _tag: "ToolsActivated", skills: freshSkills, tools: freshTools, source, decision: Option.none() }], 0).pipe(
            Effect.as([{ skills: freshSkills, tools: freshTools, active: next.tools }, next] as const))
      })
      yield* step.tools.length === 0 && step.skills.length === 0 ? Effect.void
        : run.events.publish({ _tag: "skills.activated", skills: step.skills, tools: step.tools, source }).pipe(Effect.orDie)
      return step
    })
    const activate = (requested: ReadonlyArray<string>, source: ActivationSource) => activation(requested, source).pipe(Effect.map((step) => step.active))

    const loadSkill = ({ skills: requested }: { readonly skills: ReadonlyArray<string> }) => Effect.gen(function* () {
      const loads = yield* Ref.getAndUpdate(skillLoads, (value) => value + 1)
      if (loads >= config.maxSkillLoadsPerRun) return yield* Effect.fail(failure("SkillLoadLimit", `At most ${config.maxSkillLoadsPerRun} skill load${config.maxSkillLoadsPerRun === 1 ? "" : "s"} per turn; work with the tools already loaded`))
      // A refusal is the model's to correct; anything else (the store failing) is the turn's.
      const step = yield* activation(requested, "load_skill").pipe(
        Effect.catch((error) => Option.match(refusalOf(error), { onNone: () => Effect.die(error), onSome: (refusal) => Effect.fail(refusal) })),
      )
      return skillInstructions(skills.filter((skill) => requested.includes(skill.id)), step.tools)
    })

    const readReference = ({ skill, reference }: { readonly skill: string; readonly reference: string }) => Effect.gen(function* () {
      const loaded = (yield* SynchronizedRef.get(activated)).skills
      const found = skills.find((candidate) => candidate.id === skill)?.references.find((item) => item.id === reference)
      if (!loaded.includes(skill)) return yield* Effect.fail(failure("SkillNotLoaded", `Load ${skill} with load_skill first`))
      if (found === undefined) return yield* Effect.fail(failure("UnknownReference", `${skill} has no reference ${reference}`))
      return found.text
    })

    const wrap = (entry: RegisteredTool, handler: RegisteredTool["handler"], capture: Option.Option<ToolInterceptCapture> = Option.none()) => (params: unknown, context: Toolkit.HandlerContext<Tool.Any>) => Effect.gen(function* () {
      const owner = Option.flatMap(capture, (value) => value.owner)
      const metadata = yield* Ref.make(Option.none<ToolResultInterception>())
      const operation = Effect.gen(function* () {
        const name = entry.tool.name
        const toolPolicy = Object.hasOwn(policies, name) ? policies[name] ?? {} : {}
        const agentRun = yield* Effect.service(CurrentAgentRun)
        const runKey = Option.match(agentRun, { onNone: () => "direct", onSome: (current) => canonicalJson([current.id, current.turn, current.ordinal]) })
        const isOwn = own.includes(entry)
        // The call's id first: a refused call has one too, and its `tool.refused` carries it.
        const sequence = yield* Ref.getAndUpdate(invocation, (value) => value + 1)
        const invocationId = InvocationId.make(`${run.runId}:call:${sequence}`)
        yield* Option.match(owner, { onNone: () => Effect.void, onSome: (owner) => owner.claim(invocationId).pipe(Effect.orDie) })
        const step = Option.getOrElse(yield* Effect.service(CurrentAgentStep), () => 0)
        const toolCall = context.toolCallId === undefined ? {} : { toolCallId: ToolCallId.make(context.toolCallId) }
        yield* Effect.annotateCurrentSpan({
          "efferent.invocation.id": invocationId,
          ...(context.toolCallId === undefined ? {} : { "efferent.tool.call.id": context.toolCallId }),
        })
        const identity: ToolInterceptIdentity = { invocationId, tool: name, ...toolCall, run: agentRun, step }
        const audit = (phase: ToolInterceptAudit) => run.events.publish({ _tag: "tool.intercepted", ...identity, phase, source: Option.isSome(owner) ? "loop" : "direct" }).pipe(Effect.andThen(run.flush), Effect.orDie)
        const decode = (schema: Schema.Top, encoded: unknown) => toolInterceptBoundary(
          // Authored codecs may mutate their input; accepted evidence stays frozen.
          toolInterceptMutableJson(encoded).pipe(Effect.flatMap((input) => Schema.decodeUnknownEffect(contextFree(schema))(input)), Effect.provide(runServices), Effect.interruptible),
        ).pipe(Effect.orDie)
        const failureOutcome = (encoded: unknown) => decode(entry.tool.failureSchema, encoded).pipe(
          Effect.flatMap((value) => isTurnError(value) ? Effect.die(value) : Effect.succeed(Option.some(Exit.fail(value)))),
        )
        /** Publish the refusal, then fail the call with it: the model reads it as the call's result. */
        const refuse = (reason: ToolRefusalReason, error: string, message: string, input: unknown = params) =>
          run.events.publish({ _tag: "tool.refused", step, invocationId, ...toolCall, tool: name, input, reason, message }).pipe(
            // A subscriber failure fails the turn, never the tool call (which the model would see).
            Effect.orDie,
            Effect.andThen(Effect.fail(failure(error, message))),
          )
        if (!isOwn && !(yield* SynchronizedRef.get(activated)).tools.includes(name)) {
          const providers = skillsForTool(name)
          return yield* refuse("inactive", "ToolInactive", providers.length === 0 ? `${name} is not available in this conversation`
            : `${name} is not loaded yet; call load_skill with one of: ${providers.join(", ")}`)
        }
        const missing = entry.annotations.permissions.filter((permission) => !grants.has(permission))
        if (missing.length > 0) return yield* refuse("forbidden", "PermissionDenied", `${name} requires ${missing.join(", ")}`)
        const authorized: Effect.Effect<void, HarnessError> = Option.match(policy, { onNone: () => Effect.void, onSome: (service) => service.authorize(name, params) })
        const denial = yield* authorized.pipe(Effect.match({ onFailure: Option.some, onSuccess: () => Option.none<HarnessError>() }))
        if (Option.isSome(denial)) return yield* refuse("denied", "PolicyDenied", denial.value.message)
        const before = yield* Option.match(interceptor, {
          onNone: () => Effect.succeed(Option.none<BeforeToolDecision>()),
          onSome: (service) => Option.match(capture, {
            onNone: () => Effect.die(toolInterceptError({ tool: name })),
            onSome: (captured) => beforeToolIntercept(service, { ...identity, input: captured.input }).pipe(Effect.map(Option.some), Effect.orDie),
          }),
        })
        const rewritten = Option.filter(before, (decision) => decision._tag === "Rewrite")
        const effective = Option.isSome(rewritten)
          ? yield* Schema.isSchema(entry.tool.parametersSchema) ? decode(entry.tool.parametersSchema, rewritten.value.input) : toolInterceptMutableJson(rewritten.value.input).pipe(Effect.orDie)
          : params
        const synthetic = yield* Option.match(before, {
          onNone: () => Effect.succeed(Option.none<Exit.Exit<unknown, unknown>>()),
          onSome: (decision) => Match.valueTags(decision, {
            Allow: () => Effect.succeed(Option.none<Exit.Exit<unknown, unknown>>()),
            Rewrite: () => Effect.succeed(Option.none<Exit.Exit<unknown, unknown>>()),
            Deny: ({ failure }) => failureOutcome(failure),
            Respond: ({ outcome }) => Match.valueTags(outcome, {
              Success: ({ encoded }) => decode(entry.tool.successSchema, encoded).pipe(Effect.map((value) => Option.some(Exit.succeed(value)))),
              Failure: ({ encoded }) => failureOutcome(encoded),
            }),
          }),
        })
        yield* Option.match(before, { onNone: () => Effect.void, onSome: (decision) => Effect.gen(function* () {
          yield* Ref.set(metadata, Option.some({ invocationId, ...Option.match(rewritten, { onNone: () => ({}), onSome: ({ input }) => ({ effectiveInput: input }) }) }))
          const projection: ToolInterceptAudit = { _tag: "Before", decision: Match.valueTags(decision, {
            Allow: () => ({ _tag: "Allow" as const }), Deny: ({ failure }) => ({ _tag: "Deny" as const, failure }),
            Rewrite: ({ input }) => ({ _tag: "Rewrite" as const, input }), Respond: ({ outcome }) => ({ _tag: "Respond" as const, kind: outcome._tag }),
          }) }
          yield* audit(projection)
        }) })
        if (Option.isSome(before) && before.value._tag === "Deny" && Option.isSome(synthetic)) {
          yield* run.events.publish({ _tag: "tool.refused", step, invocationId, ...toolCall, tool: name, input: effective, reason: "intercepted", message: before.value.failure.message }).pipe(Effect.orDie)
          return yield* synthetic.value
        }
        if (Option.isSome(rewritten) && Option.isSome(policy)) {
          const rejected = yield* policy.value.authorize(name, effective).pipe(Effect.match({ onFailure: Option.some, onSuccess: () => Option.none<HarnessError>() }))
          if (Option.isSome(rejected)) return yield* refuse("denied", "PolicyDenied", rejected.value.message, effective)
        }
        const denied = yield* Ref.modify(admission, (state) => admitTool(state, runKey, name, toolPolicy, config.maxCallsPerRun, entry.annotations.maxCallsPerRun))
        if (Option.isSome(denied)) {
          const reason = denied.value
          if (reason === "call-limit") return yield* refuse(reason, "CallLimit", `The turn's ${config.maxCallsPerRun}-call limit is reached; deliver with what you have`, effective)
          if (reason === "tool-call-limit") return yield* refuse(reason, "ToolCallLimit", `${name} may be called at most ${Option.getOrElse(entry.annotations.maxCallsPerRun, () => 0) === 1 ? "once" : `${Option.getOrElse(entry.annotations.maxCallsPerRun, () => 0)} times`} per turn; use what its earlier calls returned`, effective)
          if (reason === "run-call-limit") return yield* refuse(reason, "ToolCallLimit", runCallLimitMessage(toolPolicy.maxCallsPerRun ?? 0), effective)
          return yield* refuse(reason, "ToolTripped", trippedMessage(), effective)
        }
        const labels = entry.annotations.labels
        const stage = entry.annotations.stage
        // A subscriber failure fails the turn, never the tool call (which the model would see).
        if (Option.isSome(synthetic)) return yield* synthetic.value
        yield* run.events.publish({ _tag: "tool.started", step, invocationId, ...toolCall, tool: name, input: effective, labels, stage }).pipe(Effect.orDie)
        // The call is durable before its handler can perform any externally visible action.
        yield* run.flush.pipe(Effect.orDie)
        const started = yield* Clock.currentTimeMillis
        // The invocation innermost: a handler sees its own call even when the run's services carry an outer one.
        const call = Effect.suspend(() => handler(effective)).pipe(Effect.provideService(CurrentToolInvocation, Option.some({ invocationId, ...toolCall, tool: name, step })))
        const nested = yield* Effect.service(HoldingToolGates)
        const take = (gate: Semaphore.Semaphore, permits: number) => nested ? gate.takeIfAvailable(permits) : gate.take(permits).pipe(Effect.as(true))
        const acquire = (gate: Semaphore.Semaphore, permits: number) => Effect.acquireRelease(take(gate, permits), (taken) => taken ? gate.release(permits).pipe(Effect.asVoid) : Effect.void, { interruptible: true })
        const guarded = Effect.scoped(Effect.gen(function* () {
          const gate = toolGates.get(name) ?? Option.none<Semaphore.Semaphore>()
          const toolTaken = yield* Option.match(gate, { onNone: () => Effect.succeed(true), onSome: (semaphore) => acquire(semaphore, 1) })
          if (!toolTaken) return { _tag: "Busy" } as const
          // Try-acquire ignores semaphore waiters. Keep writers' priority explicit
          // across the free-before-wake gap, including nested synchronous fibers.
          if (!entry.annotations.readOnly) yield* Effect.acquireRelease(
            Ref.update(pendingWriters, (count) => count + 1), () => Ref.update(pendingWriters, (count) => count - 1),
          )
          const rwTaken = yield* entry.annotations.readOnly
            ? Effect.acquireRelease(
              (nested ? turnstile.withPermitsIfAvailable(1)(Ref.get(pendingWriters).pipe(Effect.flatMap((count) => count > 0 ? Effect.succeed(false) : readLane.takeIfAvailable(1)))).pipe(Effect.map((value) => Option.getOrElse(value, () => false)))
                : turnstile.withPermits(1)(readLane.take(1)).pipe(Effect.as(true))),
              (taken) => taken ? readLane.release(1).pipe(Effect.asVoid) : Effect.void,
              { interruptible: true },
            )
            : acquire(turnstile, 1).pipe(Effect.flatMap((taken) => !taken ? Effect.succeed(false) : Ref.get(pendingWriters).pipe(
              Effect.flatMap((count) => nested && count > 1 ? Effect.succeed(false) : acquire(readLane, config.readConcurrency)),
            )))
          if (!rwTaken) return { _tag: "Busy" } as const
          if (breakerOf(yield* Ref.get(admission), runKey, name)._tag === "Tripped") return { _tag: "Tripped" } as const
          const exit = yield* Effect.exit(call.pipe(
            Effect.provide(runServices), Effect.provideService(HoldingToolGates, true),
            // Finalize the actual handler exit before releasing execution permits.
            // Cancellation after that exit cannot erase a defect or a success reset.
            Effect.onExit((exit) => {
              const outcome = Exit.isSuccess(exit) ? "success" : exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && isTurnError(reason.defect) || Cause.isFailReason(reason) && isTurnError(reason.error))
                || exit.cause.reasons.some(Cause.isInterruptReason) ? "unrelated" : exit.cause.reasons.some(Cause.isDieReason) ? "defect" : "failure"
              return Ref.update(admission, (state) => settleToolAdmission(state, runKey, name, toolPolicy, outcome))
            }),
          ))
          return { _tag: "Ran", exit } as const
        }))
        const execution = yield* guarded
        const exit = yield* Match.valueTags(execution, {
          Busy: () => refuse("concurrency", "ToolConcurrency", concurrencyMessage(), effective),
          Tripped: () => refuse("tripped", "ToolTripped", trippedMessage(), effective),
          Ran: ({ exit }) => Effect.succeed(exit),
        })
        if (Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)) return yield* Effect.failCause(exit.cause)
        const durationMs = (yield* Clock.currentTimeMillis) - started
        const ok = Exit.isSuccess(exit)
        // A defect reaches the model (and the journal, through `tool.completed`) as the first line of its message;
        // its stack, with the host's paths, goes to the log only.
        const value: unknown = Exit.isSuccess(exit) ? exit.value
          : Option.getOrElse(Cause.findErrorOption(exit.cause), () => failure("ToolDefect", `${name} failed unexpectedly: ${firstLine(messagesOf(exit.cause)).slice(0, 300)}`))
        // A TurnError the handler died with is the turn's, not the tool's: a subscriber failed on an event the
        // handler published (`tool.progress`, `skills.activated`), or the writer or the store failed load_skill's
        // activation (`TurnClosed`, `SessionLogError`...). Like a failure on `tool.started`, it fails the turn once
        // `tool.completed` is out, instead of reaching the model as a ToolDefect.
        const turnFailure = Exit.isSuccess(exit) ? Option.none<TurnError>()
          : Option.fromNullishOr(exit.cause.reasons.flatMap((reason) => Cause.isDieReason(reason) && isTurnError(reason.defect) ? [reason.defect] : Cause.isFailReason(reason) && isTurnError(reason.error) ? [reason.error] : [])[0])
        if (Exit.isFailure(exit) && Option.isNone(Cause.findErrorOption(exit.cause)) && Option.isNone(turnFailure)) {
          yield* Effect.logError(`${name} failed unexpectedly`, exit.cause).pipe(Effect.annotateLogs({ tool: name, invocationId }))
        }
        const encoded = yield* Schema.encodeUnknownEffect(contextFree(ok ? entry.tool.successSchema : entry.tool.failureSchema))(value).pipe(
          Effect.catch((error) => isTurnError(error) ? Effect.die(error) : Effect.logWarning(`${name} returned a value its own schema does not encode; it is recorded as returned`, error).pipe(Effect.as(value))),
        )
        const candidate = Option.isSome(interceptor) && Option.isNone(turnFailure)
          ? Option.some(yield* toolInterceptSnapshot(ToolInterceptOutcome, ok ? { _tag: "Success", encoded } : { _tag: "Failure", encoded }).pipe(Effect.result)) : Option.none()
        yield* run.events.publish({ _tag: "tool.completed", step, invocationId, ...toolCall, tool: name, input: effective, ok, result: value, encoded, durationMs, labels, stage }).pipe(Effect.orDie)
        if (Option.isSome(turnFailure)) return yield* Effect.die(turnFailure.value)
        const accepted = yield* Option.match(candidate, {
          onNone: () => Effect.succeed(Option.none<ToolInterceptOutcome>()),
          onSome: (result) => Result.match(result, { onFailure: Effect.die, onSuccess: (value) => Effect.succeed(Option.some(value)) }),
        })
        if (Option.isSome(interceptor) && Option.isSome(capture) && Option.isSome(accepted)) {
          const decision = yield* afterToolIntercept(interceptor.value, { ...identity, input: Option.isSome(rewritten) ? rewritten.value.input : capture.value.input, outcome: accepted.value }).pipe(Effect.orDie)
          const replacement = yield* Match.valueTags(decision, {
            Keep: () => Effect.succeed(Option.none<Exit.Exit<unknown, unknown>>()),
            Replace: ({ outcome }) => Match.valueTags(outcome, {
              Success: ({ encoded }) => decode(entry.tool.successSchema, encoded).pipe(Effect.map((value) => Option.some(Exit.succeed(value)))),
              Failure: ({ encoded }) => failureOutcome(encoded),
            }),
          })
          yield* audit({ _tag: "After", decision: Match.valueTags(decision, {
            Keep: () => ({ _tag: "Keep" as const }), Replace: ({ outcome }) => ({ _tag: "Replace" as const, kind: outcome._tag }),
          }) })
          if (Option.isSome(replacement)) return yield* replacement.value
        }
        return yield* ok ? Effect.succeed(value) : Effect.fail(value)
      })
      return yield* operation.pipe(Effect.onExit((exit) => {
        const ordinary = Exit.isSuccess(exit) || exit.cause.reasons.length > 0 && exit.cause.reasons.every((reason) => Cause.isFailReason(reason) && !isTurnError(reason.error))
        return !ordinary ? Effect.void : Option.match(owner, { onNone: () => Effect.void, onSome: (owner) => Ref.get(metadata).pipe(Effect.flatMap(owner.ready), Effect.orDie) })
      }))
    }).pipe(Effect.withSpan(`tool.${entry.tool.name}`, { attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": entry.tool.name,
    } }), Effect.provide(runServices), withToolResultReceiptGuard)

    const handlerOf = (entry: RegisteredTool): RegisteredTool["handler"] =>
      entry.tool.name === LoadSkill.name ? (params) => loadSkill(params as { readonly skills: ReadonlyArray<string> })
        : entry.tool.name === ReadSkillReference.name ? (params) => readReference(params as { readonly skill: string; readonly reference: string })
          : entry.handler

    const toolkit: Toolkit.Toolkit<Record<string, Tool.Any>> = Toolkit.make(...registered.map((entry) => entry.tool))
    const handlers = yield* toolkit.toHandlers(Object.fromEntries(registered.map((entry) => [entry.tool.name, wrap(entry, handlerOf(entry))]))).pipe(
      Effect.updateContext((context: Context.Context<never>) => Context.omit(CurrentAgentRun, CurrentAgentStep, CurrentToolResultReceipt, HoldingToolGates)(context)),
    )
    const providedToolkit = Option.isNone(interceptor) ? toolkit : interceptedToolkit(toolkit, runServices, (name, capture) => {
      const entry = byName.get(name)
      return toolkit.toHandlers(entry === undefined ? {} : { [name]: wrap(entry, handlerOf(entry), Option.some(capture)) }).pipe(
        Effect.updateContext((context: Context.Context<never>) => Context.omit(CurrentAgentRun, CurrentAgentStep, CurrentToolResultReceipt, HoldingToolGates)(context)),
      )
    })

    const always = skills.filter((skill) => skill.always).map((skill) => skill.id)
    const candidates = skills.filter((skill) => !skill.always)
    const candidateHash = fingerprintOf(canonicalJson(candidates.map((skill) => [skill.id, skill.version])))

    /** The tools active once the always-on skills are: what the matcher is told is already there. */
    const activeWithAlways = Effect.gen(function* () {
      const current = (yield* SynchronizedRef.get(activated)).tools
      if (always.length === 0) return current
      const resolved = yield* resolveCapabilities(catalog, { recipes: always, tools: [] }, grants)
      return [...current, ...resolved.tools.map((tool) => tool.id).filter((tool) => !current.includes(tool))]
    })

    /** Ask the matcher. Nothing is activated, recorded or published. */
    const match = (userMessage: UserMessage) => Effect.gen(function* () {
      if (Option.isNone(matcher)) return { userMessage, skills: [], probabilities: Option.none(), record: Option.none() } satisfies SkillMatch
      const selector = matcher.value
      const history = yield* session.transcript("reference")
      const loadedBefore = (yield* SynchronizedRef.get(activated)).skills
      const activeNow = yield* activeWithAlways
      const outcome = yield* selector.match({ userMessage, skills: candidates, active: activeNow, history }).pipe(
        Effect.timeoutOrElse({ duration: `${config.matcherTimeoutMs} millis`, orElse: () => Effect.fail(harness("matcher.timeout", "The skill matcher timed out")) }),
        Effect.result,
      )
      const chosen = outcome._tag === "Success" && !outcome.success.abstained
        ? outcome.success.skills.filter((id) => candidates.some((skill) => skill.id === id) && !loadedBefore.includes(id))
        : []
      // A multi-label decision: `selection` is the chosen skill ids joined by ",".
      const selection = chosen.length === 0 ? Option.none<string>() : Option.some(chosen.join(","))
      const probabilities = outcome._tag === "Success" ? outcome.success.probabilities : Option.none()
      const decision = yield* Ref.getAndUpdate(decisions, (value) => value + 1)
      const record: DecisionRecord = {
        version: 1,
        id: DecisionId.make(`${run.runId}:skill-selection:${decision}`),
        family: "skill-selection",
        // Hashed under its original key, so decision context hashes are unchanged; images join by fingerprint, only when there are some.
        contextHash: fingerprintOf(canonicalJson({
          message: userMessage.text, active: activeNow, history: history.length,
          ...(attachmentsOf(userMessage).length === 0 ? {} : { attachments: attachmentsOf(userMessage).map((media) => media.fingerprint) }),
        })),
        candidateHash,
        policyVersion: `${selector.id}@${selector.version}`,
        candidates: candidates.map((skill) => ({ id: CandidateId.make(skill.id), description: skill.summary })),
        attempts: [],
        selection,
        validation: outcome._tag === "Failure" ? "failed" : outcome.success.abstained || chosen.length === 0 ? "abstained" : "accepted",
        fallback: outcome._tag === "Failure" ? Option.some(`always-on: ${outcome.failure.message}`) : Option.none(),
        applied: selection,
        probabilities,
      }
      return { userMessage, skills: chosen, probabilities, record: Option.some(record) } satisfies SkillMatch
    })

    /** Activate the always-on skills and the match, record the decision, seed the load_skill exchange. */
    const apply = (matched: SkillMatch) => Effect.gen(function* () {
      yield* always.length === 0 ? Effect.void : activate(always, "always").pipe(Effect.asVoid)
      const loaded = (yield* SynchronizedRef.get(activated)).skills
      const chosen = matched.skills.filter((id) => !loaded.includes(id))
      // Only a refusal rejects the choice; a failure to record it fails the apply, and is never recorded as a rejection.
      const applied = yield* chosen.length === 0 ? Effect.succeed(false) : activate(chosen, "matcher").pipe(
        Effect.as(true),
        Effect.catchIf(isRefusal, () => Effect.succeed(false)),
      )
      yield* Option.match(matched.record, {
        onNone: () => Effect.void,
        onSome: (record) => recordDecision({
          ...record,
          validation: record.validation === "accepted" && !applied ? "rejected" : record.validation,
          applied: applied ? record.selection : Option.none(),
        }).pipe(Effect.provideService(RunContext, run)),
      })
      if (applied && config.loadSkill) {
        const seeded = skills.filter((skill) => chosen.includes(skill.id))
        const seed = yield* Ref.getAndUpdate(seeds, (value) => value + 1)
        const callId = ToolCallId.make(`${run.runId}:matcher:${seed}`)
        yield* session.recordTail([
          { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: LoadSkill.name, input: { skills: chosen } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: LoadSkill.name, output: skillInstructions(seeded, []), isError: false }] },
        ], views, 0)
      }
      return (yield* SynchronizedRef.get(activated)).tools
    })

    const select = (userMessage: UserMessage) => match(userMessage).pipe(Effect.flatMap(apply))

    return {
      toolkit: providedToolkit,
      handlers,
      active: SynchronizedRef.get(activated).pipe(Effect.map((held) => [...own.map((entry) => entry.tool.name), ...held.tools])),
      activate,
      match,
      apply,
      select,
      views: viewsFor(runServices),
      pollable: registered.filter((entry) => entry.annotations.pollable).map((entry) => entry.tool.name),
      skills,
    } satisfies RunTools
  })

  return { catalog, open, views, skills }
})

