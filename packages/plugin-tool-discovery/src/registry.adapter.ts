import { Tool, Toolkit } from "@effect/ai"
import { Cause, Clock, Context, Effect, Exit, Option, Ref, Schema } from "effect"
import {
  activationsOf,
  canonicalJson,
  catalogOf,
  defineTool,
  Failure,
  HarnessError,
  noHooks,
  resolveCapabilities,
  RunContext,
  ToolCallId,
} from "@xandreed/core"
import type {
  ActivationSource,
  AgentMessage,
  CapabilityCatalog,
  Contribution,
  IntentMatch,
  MemorySession,
  RegisteredTool,
  RunTools,
  SkillDefinition,
  ToolView,
  ToolViews,
} from "@xandreed/core"

export interface DiscoveryConfig {
  readonly grants: ReadonlyArray<string>
  readonly loadSkill: boolean
  readonly maxCallsPerRun: number
  readonly maxSkillLoadsPerRun: number
  readonly readConcurrency: number
  readonly matcherTimeoutMs: number
  readonly catalogVersion: string
}

export interface DiscoveryServices {
  readonly matcher: Option.Option<{
    readonly id: string
    readonly version: string
    readonly match: (input: { readonly message: string; readonly skills: ReadonlyArray<SkillDefinition>; readonly active: ReadonlyArray<string>; readonly history: ReadonlyArray<AgentMessage> }) => Effect.Effect<IntentMatch, HarnessError>
  }>
  readonly grants: Option.Option<Effect.Effect<ReadonlySet<string>, HarnessError>>
  readonly authorize: Option.Option<(tool: string, input: unknown) => Effect.Effect<void, HarnessError>>
}

const failure = (error: string, message: string) => ({ error, message })
const harness = (code: string, message: string) => new HarnessError({ code, message })

const LoadSkill = Tool.make("load_skill", {
  description: "Load one or more skills from the catalogue: returns their instructions and makes their tools available from the next step. Load a skill before doing work it covers.",
  parameters: { skills: Schema.Array(Schema.String) },
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

const ReadSkillReference = Tool.make("read_skill_reference", {
  description: "Read one reference document listed by a loaded skill.",
  parameters: { skill: Schema.String, reference: Schema.String },
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

const rawText = (encoded: unknown): string => typeof encoded === "string" ? encoded : canonicalJson(encoded)

/** Tool result schemas are context-free by contract (they cross the wire). */
const contextFree = (schema: Schema.Schema.All): Schema.Schema<unknown, unknown> => schema as Schema.Schema<unknown, unknown>

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

export const makeRegistry = (config: DiscoveryConfig, contributions: ReadonlyArray<Contribution>, services: DiscoveryServices) => Effect.gen(function* () {
  const own: ReadonlyArray<RegisteredTool> = config.loadSkill ? [
    defineTool({ tool: LoadSkill, handler: () => Effect.die("bound per run"), annotations: { readOnly: true, pinned: true } }),
    defineTool({ tool: ReadSkillReference, handler: () => Effect.die("bound per run"), annotations: { readOnly: true } }),
  ] : []
  const registered = [...contributions.flatMap((contribution) => contribution.tools), ...own]
  const duplicateTool = registered.find((entry, index) => registered.findIndex((other) => other.tool.name === entry.tool.name) !== index)
  if (duplicateTool !== undefined) return yield* Effect.fail(harness("tools.duplicate", `Two contributions define the tool ${duplicateTool.tool.name}`))
  const skills = contributions.flatMap((contribution) => contribution.skills)
  const duplicateSkill = skills.find((skill, index) => skills.findIndex((other) => other.id === skill.id) !== index)
  if (duplicateSkill !== undefined) return yield* Effect.fail(harness("skills.duplicate", `Two contributions define the skill ${duplicateSkill.id}`))
  const unknownTool = skills.flatMap((skill) => skill.tools.filter((tool) => !registered.some((entry) => entry.tool.name === tool)).map((tool) => `${skill.id} → ${tool}`))
  if (unknownTool.length > 0) return yield* Effect.fail(harness("skills.tools", `Skills reference unregistered tools: ${unknownTool.join(", ")}`))
  const catalog: CapabilityCatalog = catalogOf(config.catalogVersion, [...contributions, {
    id: "tool-discovery", version: "1", tools: own, skills: [], sections: [], run: Option.none(), hooks: noHooks,
  }])
  const byName = new Map(registered.map((entry) => [entry.tool.name, entry] as const))
  const skillsForTool = (tool: string) => skills.filter((skill) => skill.tools.includes(tool)).map((skill) => skill.id)
  const onToolResult = contributions.flatMap((contribution) => Option.toArray(contribution.hooks.onToolResult))

  const views: ToolViews = {
    view: (name, encoded, params, isError) => {
      const entry = byName.get(name)
      const pinned = entry?.annotations.pinned ?? false
      const raw: ToolView = { text: rawText(encoded), version: "raw", subjects: [], pinned }
      if (entry === undefined || isError || Option.isNone(entry.view)) return Effect.succeed(raw)
      const view = entry.view.value
      return Schema.decodeUnknown(contextFree(entry.tool.successSchema))(encoded).pipe(
        Effect.map((result): ToolView => ({ text: view.render(result, params), version: view.version, subjects: view.subjects(result, params), pinned })),
        Effect.orElseSucceed(() => raw),
      )
    },
    compact: (name, encoded, params) => {
      const view = Option.flatMap(Option.fromNullable(byName.get(name)), (entry) => entry.view)
      const compact = Option.flatMap(view, (value) => value.compact)
      const entry = byName.get(name)
      return Option.isNone(compact) || entry === undefined ? Effect.succeed(Option.none())
        : Schema.decodeUnknown(contextFree(entry.tool.successSchema))(encoded).pipe(
          Effect.map((result) => Option.some(compact.value(result, params))),
          Effect.orElseSucceed(() => Option.none<string>()),
        )
    },
  }

  const open = (session: MemorySession, runServices: Context.Context<never>) => Effect.gen(function* () {
    const run = yield* Option.match(Context.getOption(runServices, RunContext), {
      onNone: () => Effect.fail(harness("tools.run", "The run context is missing")),
      onSome: Effect.succeed,
    })
    const grants = yield* Option.match(services.grants, { onNone: () => Effect.succeed<ReadonlySet<string>>(new Set(config.grants)), onSome: (value) => value })
    const initial = activationsOf(yield* session.entries)
    const active = yield* Ref.make(initial.tools)
    const loadedSkills = yield* Ref.make(initial.skills)
    const calls = yield* Ref.make(new Map<string, number>())
    const skillLoads = yield* Ref.make(0)
    const invocation = yield* Ref.make(0)
    const readLane = yield* Effect.makeSemaphore(config.readConcurrency)
    const writeLane = yield* Effect.makeSemaphore(1)

    const activate = (requested: ReadonlyArray<string>, source: ActivationSource) => Effect.gen(function* () {
      const unknown = requested.filter((id) => !skills.some((skill) => skill.id === id))
      if (unknown.length > 0) return yield* Effect.fail(harness("skills.unknown", `Unknown skills: ${unknown.join(", ")}`))
      const resolved = yield* resolveCapabilities(catalog, { recipes: [...requested], tools: [] }, grants)
      const current = yield* Ref.get(active)
      const fresh = resolved.tools.map((tool) => tool.id).filter((tool) => !current.includes(tool))
      const loaded = yield* Ref.get(loadedSkills)
      const freshSkills = requested.filter((id) => !loaded.includes(id))
      if (fresh.length > 0 || freshSkills.length > 0) {
        yield* session.record([{ _tag: "ToolsActivated", skills: freshSkills, tools: fresh, source, decision: Option.none() }], 0)
        yield* Ref.set(active, [...current, ...fresh])
        yield* Ref.set(loadedSkills, [...loaded, ...freshSkills])
        yield* run.publish({ name: "capabilities.expanded", runId: run.runId, data: { source, skills: freshSkills, tools: fresh } })
      }
      return yield* Ref.get(active)
    })

    const loadSkill = ({ skills: requested }: { readonly skills: ReadonlyArray<string> }) => Effect.gen(function* () {
      const loads = yield* Ref.getAndUpdate(skillLoads, (value) => value + 1)
      if (loads >= config.maxSkillLoadsPerRun) return yield* Effect.fail(failure("SkillLoadLimit", `At most ${config.maxSkillLoadsPerRun} skill loads per turn`))
      const before = yield* Ref.get(active)
      yield* activate(requested, "load_skill").pipe(Effect.mapError((error) => failure(error.code, error.message)))
      const after = yield* Ref.get(active)
      return skillInstructions(skills.filter((skill) => requested.includes(skill.id)), after.filter((tool) => !before.includes(tool)))
    })

    const readReference = ({ skill, reference }: { readonly skill: string; readonly reference: string }) => Effect.gen(function* () {
      const loaded = yield* Ref.get(loadedSkills)
      const found = skills.find((candidate) => candidate.id === skill)?.references.find((item) => item.id === reference)
      if (!loaded.includes(skill)) return yield* Effect.fail(failure("SkillNotLoaded", `Load ${skill} with load_skill first`))
      if (found === undefined) return yield* Effect.fail(failure("UnknownReference", `${skill} has no reference ${reference}`))
      return found.text
    })

    const wrap = (entry: RegisteredTool, handler: (params: unknown) => Effect.Effect<unknown, unknown, unknown>) => (params: unknown) => Effect.gen(function* () {
      const name = entry.tool.name
      const isOwn = own.includes(entry)
      if (!isOwn && !(yield* Ref.get(active)).includes(name)) {
        const providers = skillsForTool(name)
        return yield* Effect.fail(failure("ToolInactive", providers.length === 0 ? `${name} is not available in this conversation`
          : `${name} is not loaded yet; call load_skill with one of: ${providers.join(", ")}`))
      }
      const missing = entry.annotations.permissions.filter((permission) => !grants.has(permission))
      if (missing.length > 0) return yield* Effect.fail(failure("Forbidden", `${name} requires ${missing.join(", ")}`))
      const authorized: Effect.Effect<void, HarnessError> = Option.match(services.authorize, { onNone: () => Effect.void, onSome: (authorize) => authorize(name, params) })
      yield* authorized.pipe(Effect.mapError((error) => failure("Denied", error.message)))
      const counts = yield* Ref.get(calls)
      const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
      if (total >= config.maxCallsPerRun) return yield* Effect.fail(failure("CallLimit", `The turn's ${config.maxCallsPerRun}-call limit is reached; deliver with what you have`))
      if (Option.isSome(entry.annotations.maxCallsPerRun) && (counts.get(name) ?? 0) >= entry.annotations.maxCallsPerRun.value) {
        return yield* Effect.fail(failure("ToolCallLimit", `${name} may be called at most ${entry.annotations.maxCallsPerRun.value} times per turn`))
      }
      yield* Ref.update(calls, (all) => new Map([...all, [name, (all.get(name) ?? 0) + 1]]))
      const sequence = yield* Ref.getAndUpdate(invocation, (value) => value + 1)
      const invocationId = `${run.runId}:call:${sequence}`
      const labels = entry.annotations.labels
      const stage = Option.getOrNull(entry.annotations.stage)
      yield* run.publish({ name: "tool.invocation", runId: run.runId, data: { invocationId, tool: name, input: params, labels, stage } })
      const started = yield* Clock.currentTimeMillis
      const lane = entry.annotations.readOnly ? readLane : writeLane
      const exit = yield* lane.withPermits(1)(Effect.exit(handler(params).pipe(Effect.provide(runServices))))
      const durationMs = (yield* Clock.currentTimeMillis) - started
      const ok = Exit.isSuccess(exit)
      const value: unknown = Exit.isSuccess(exit) ? exit.value
        : Option.getOrElse(Cause.failureOption(exit.cause), () => failure("ToolDefect", `${name} failed unexpectedly: ${Cause.pretty(exit.cause).slice(0, 300)}`))
      const encoded = yield* Schema.encodeUnknown(contextFree(ok ? entry.tool.successSchema : entry.tool.failureSchema))(value).pipe(Effect.orElseSucceed(() => value))
      yield* run.publish({ name: "tool.result", runId: run.runId, data: { invocationId, tool: name, ok, output: encoded, durationMs, labels, stage } })
      yield* Effect.forEach(onToolResult, (hook) => hook({ tool: name, invocationId, input: params, ok, encoded }).pipe(Effect.provide(runServices)))
      return yield* ok ? Effect.succeed(value) : Effect.fail(value)
    }).pipe(Effect.withSpan(`tool.${entry.tool.name}`), Effect.provide(runServices))

    const handlerOf = (entry: RegisteredTool): ((params: unknown) => Effect.Effect<unknown, unknown, unknown>) =>
      entry.tool.name === LoadSkill.name ? (params) => loadSkill(params as { readonly skills: ReadonlyArray<string> })
        : entry.tool.name === ReadSkillReference.name ? (params) => readReference(params as { readonly skill: string; readonly reference: string })
          : entry.handler

    const toolkit = Toolkit.make(...(registered.map((entry) => entry.tool) as never))
    const handlers = yield* (toolkit as never as Toolkit.Toolkit<Record<string, Tool.Any>>).toContext(
      Object.fromEntries(registered.map((entry) => [entry.tool.name, wrap(entry, handlerOf(entry))])) as never,
    )

    const select = (message: string) => Effect.gen(function* () {
      const always = skills.filter((skill) => skill.always).map((skill) => skill.id)
      yield* always.length === 0 ? Effect.void : activate(always, "always").pipe(Effect.asVoid)
      if (Option.isNone(services.matcher)) return yield* Ref.get(active)
      const matcher = services.matcher.value
      const candidates = skills.filter((skill) => !skill.always)
      const history = yield* session.transcript("reference")
      const loadedBefore = yield* Ref.get(loadedSkills)
      const match = yield* matcher.match({ message, skills: candidates, active: yield* Ref.get(active), history }).pipe(
        Effect.timeoutFail({ duration: `${config.matcherTimeoutMs} millis`, onTimeout: () => harness("matcher.timeout", "The skill matcher timed out") }),
        Effect.either,
      )
      const chosen = match._tag === "Right" && !match.right.abstained
        ? match.right.skills.filter((id) => candidates.some((skill) => skill.id === id) && !loadedBefore.includes(id))
        : []
      const applied = yield* chosen.length === 0 ? Effect.succeed(false) : activate(chosen, "matcher").pipe(Effect.as(true), Effect.orElseSucceed(() => false))
      yield* run.publish({ name: "decision.record", runId: run.runId, data: {
        family: "skill-selection", matcher: matcher.id, matcherVersion: matcher.version,
        candidates: candidates.map((skill) => skill.id),
        selection: chosen, applied,
        validation: match._tag === "Left" ? "failed" : match.right.abstained ? "abstained" : chosen.length === 0 ? "abstained" : applied ? "accepted" : "rejected",
        probabilities: match._tag === "Right" ? Option.getOrNull(match.right.probabilities) : null,
        error: match._tag === "Left" ? match.left.message : null,
      } })
      if (applied && config.loadSkill) {
        const seeded = skills.filter((skill) => chosen.includes(skill.id))
        const callId = ToolCallId.make(`${run.runId}:matcher`)
        yield* session.recordTail([
          { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: LoadSkill.name, input: { skills: chosen } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: LoadSkill.name, output: skillInstructions(seeded, []), isError: false }] },
        ], views, 0)
      }
      return yield* Ref.get(active)
    })

    return {
      toolkit: toolkit as never as Toolkit.Toolkit<Record<string, Tool.Any>>,
      handlers: handlers as Context.Context<never>,
      active: Ref.get(active).pipe(Effect.map((names) => [...own.map((entry) => entry.tool.name), ...names])),
      activate,
      select,
      views,
      pollable: registered.filter((entry) => entry.annotations.pollable).map((entry) => entry.tool.name),
      skills,
    } satisfies RunTools
  })

  return { catalog, open, views, skills }
})

