import { Tool, Toolkit } from "@effect/ai"
import { Cause, Clock, Context, Effect, Exit, FiberRef, Option, Ref, Schema } from "effect"
import {
  ActionPolicy,
  activationsOf,
  canonicalJson,
  CapabilityGrants,
  catalogOf,
  CurrentAgentStep,
  DecisionId,
  defineContributions,
  defineTool,
  Failure,
  fingerprintOf,
  HarnessError,
  IntentMatcher,
  recordDecision,
  resolveCapabilities,
  RunContext,
  ToolCallId,
} from "@xandreed/core"
import type {
  ActivationSource,
  CapabilityCatalog,
  Contribution,
  DecisionRecord,
  DigestTask,
  MemorySession,
  RegisteredTool,
  RunTools,
  SkillDefinition,
  SkillMatch,
  ToolView,
  ToolViews,
  UserMessage,
} from "@xandreed/core"

export interface DiscoveryConfig {
  /** Granted permissions when the turn's services carry no CapabilityGrants. */
  readonly grants: ReadonlyArray<string>
  readonly loadSkill: boolean
  readonly maxCallsPerRun: number
  readonly maxSkillLoadsPerRun: number
  readonly readConcurrency: number
  readonly matcherTimeoutMs: number
  readonly catalogVersion: string
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

/**
 * The registry over every contribution. Built once; each turn opens it with
 * its own services, where it finds the RunContext (events, memory), and the
 * optional IntentMatcher, CapabilityGrants and ActionPolicy of that turn.
 */
export const makeRegistry = (config: DiscoveryConfig, contributions: ReadonlyArray<Contribution>) => Effect.gen(function* () {
  // Tier 3 exists only when some skill ships references; otherwise its schema is dead weight.
  const hasReferences = contributions.some((contribution) => contribution.skills.some((skill) => skill.references.length > 0))
  const own: ReadonlyArray<RegisteredTool> = config.loadSkill ? [
    defineTool({ tool: LoadSkill, handler: () => Effect.die("bound per run"), annotations: { readOnly: true, pinned: true } }),
    ...(hasReferences ? [defineTool({ tool: ReadSkillReference, handler: () => Effect.die("bound per run"), annotations: { readOnly: true } })] : []),
  ] : []
  const registered = [...contributions.flatMap((contribution) => contribution.tools), ...own]
  const duplicateTool = registered.find((entry, index) => registered.findIndex((other) => other.tool.name === entry.tool.name) !== index)
  if (duplicateTool !== undefined) return yield* Effect.fail(harness("tools.duplicate", `Two contributions define the tool ${duplicateTool.tool.name}`))
  const skills = contributions.flatMap((contribution) => contribution.skills)
  const duplicateSkill = skills.find((skill, index) => skills.findIndex((other) => other.id === skill.id) !== index)
  if (duplicateSkill !== undefined) return yield* Effect.fail(harness("skills.duplicate", `Two contributions define the skill ${duplicateSkill.id}`))
  const unknownTool = skills.flatMap((skill) => skill.tools.filter((tool) => !registered.some((entry) => entry.tool.name === tool)).map((tool) => `${skill.id} → ${tool}`))
  if (unknownTool.length > 0) return yield* Effect.fail(harness("skills.tools", `Skills reference unregistered tools: ${unknownTool.join(", ")}`))
  const catalog: CapabilityCatalog = catalogOf(config.catalogVersion, [...contributions, defineContributions({ id: "tool-discovery", version: "1", tools: own })])
  const byName = new Map(registered.map((entry) => [entry.tool.name, entry] as const))
  const skillsForTool = (tool: string) => skills.filter((skill) => skill.tools.includes(tool)).map((skill) => skill.id)
  const decoded = (name: string, encoded: unknown) => Option.match(Option.fromNullable(byName.get(name)), {
    onNone: () => Effect.succeed(Option.none<{ readonly entry: RegisteredTool; readonly result: unknown }>()),
    onSome: (entry) => Schema.decodeUnknown(contextFree(entry.tool.successSchema))(encoded).pipe(
      Effect.map((result) => Option.some({ entry, result })),
      Effect.orElseSucceed(() => Option.none<{ readonly entry: RegisteredTool; readonly result: unknown }>()),
    ),
  })

  const views: ToolViews = {
    view: (name, encoded, params, isError) => {
      const entry = byName.get(name)
      const pinned = entry?.annotations.pinned ?? false
      const raw: ToolView = { text: rawText(encoded), version: "raw", subjects: [], artifacts: [], pinned }
      if (entry === undefined || isError || Option.isNone(entry.view)) return Effect.succeed(raw)
      const view = entry.view.value
      return Schema.decodeUnknown(contextFree(entry.tool.successSchema))(encoded).pipe(
        Effect.map((result): ToolView => ({
          text: view.render(result, params), version: view.version, subjects: view.subjects(result, params),
          artifacts: view.artifacts(result, params), pinned,
        })),
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
    digest: (name, encoded, params, userMessage) => decoded(name, encoded).pipe(Effect.map((found) => Option.flatMap(found, ({ entry, result }) =>
      Option.flatMap(Option.flatMap(entry.view, (view) => Option.map(view.digest, (digest) => ({ view, digest }))), ({ view, digest }): Option.Option<DigestTask> => {
        const source = view.render(result, params)
        const base = { tool: name, version: digest.version, instructions: digest.instructions, userMessage, source }
        if (digest._tag === "Summarize") {
          const preserve = digest.preserve(result)
          return Option.some({
            ...base, mode: "summarize", items: [],
            apply: (outcome) => Option.filter(outcome.summary, (summary) => summary.trim().length > 0 && preserve.every((id) => summary.includes(id))),
          })
        }
        const items = digest.items(result)
        return items.length === 0 ? Option.none() : Option.some({
          ...base, mode: "select", items,
          apply: (outcome) => {
            const keep = outcome.keep.filter((key) => items.some((item) => item.key === key))
            return keep.length === 0 ? Option.none() : Option.some(digest.render(result, params, keep))
          },
        })
      })))),
  }

  const open = (session: MemorySession, runServices: Context.Context<never>) => Effect.gen(function* () {
    const run = yield* Option.match(Context.getOption(runServices, RunContext), {
      onNone: () => Effect.fail(harness("tools.run", "The run context is missing")),
      onSome: Effect.succeed,
    })
    const matcher = Context.getOption(runServices, IntentMatcher)
    const policy = Context.getOption(runServices, ActionPolicy)
    const grants = yield* Option.match(Context.getOption(runServices, CapabilityGrants), {
      onNone: () => Effect.succeed<ReadonlySet<string>>(new Set(config.grants)),
      onSome: (service) => service.grants,
    })
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
        yield* run.events.publish({ _tag: "skills.activated", skills: freshSkills, tools: fresh, source }).pipe(Effect.orDie)
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
      const authorized: Effect.Effect<void, HarnessError> = Option.match(policy, { onNone: () => Effect.void, onSome: (service) => service.authorize(name, params) })
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
      const stage = entry.annotations.stage
      const step = Option.getOrElse(yield* FiberRef.get(CurrentAgentStep), () => 0)
      // A subscriber failure fails the turn, never the tool call (which the model would see).
      yield* run.events.publish({ _tag: "tool.started", step, invocationId, tool: name, input: params, labels, stage }).pipe(Effect.orDie)
      const started = yield* Clock.currentTimeMillis
      const lane = entry.annotations.readOnly ? readLane : writeLane
      const exit = yield* lane.withPermits(1)(Effect.exit(handler(params).pipe(Effect.provide(runServices))))
      const durationMs = (yield* Clock.currentTimeMillis) - started
      const ok = Exit.isSuccess(exit)
      const value: unknown = Exit.isSuccess(exit) ? exit.value
        : Option.getOrElse(Cause.failureOption(exit.cause), () => failure("ToolDefect", `${name} failed unexpectedly: ${Cause.pretty(exit.cause).slice(0, 300)}`))
      const encoded = yield* Schema.encodeUnknown(contextFree(ok ? entry.tool.successSchema : entry.tool.failureSchema))(value).pipe(Effect.orElseSucceed(() => value))
      yield* run.events.publish({ _tag: "tool.completed", step, invocationId, tool: name, input: params, ok, result: value, encoded, durationMs, labels, stage }).pipe(Effect.orDie)
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

    const always = skills.filter((skill) => skill.always).map((skill) => skill.id)
    const candidates = skills.filter((skill) => !skill.always)
    const candidateHash = fingerprintOf(canonicalJson(candidates.map((skill) => [skill.id, skill.version])))

    /** The tools active once the always-on skills are: what the matcher is told is already there. */
    const activeWithAlways = Effect.gen(function* () {
      const current = yield* Ref.get(active)
      if (always.length === 0) return current
      const resolved = yield* resolveCapabilities(catalog, { recipes: always, tools: [] }, grants)
      return [...current, ...resolved.tools.map((tool) => tool.id).filter((tool) => !current.includes(tool))]
    })

    /** Ask the matcher. Nothing is activated, recorded or published. */
    const match = (userMessage: UserMessage) => Effect.gen(function* () {
      if (Option.isNone(matcher)) return { userMessage, skills: [], probabilities: Option.none(), record: Option.none() } satisfies SkillMatch
      const selector = matcher.value
      const history = yield* session.transcript("reference")
      const loadedBefore = yield* Ref.get(loadedSkills)
      const activeNow = yield* activeWithAlways
      const outcome = yield* selector.match({ userMessage, skills: candidates, active: activeNow, history }).pipe(
        Effect.timeoutFail({ duration: `${config.matcherTimeoutMs} millis`, onTimeout: () => harness("matcher.timeout", "The skill matcher timed out") }),
        Effect.either,
      )
      const chosen = outcome._tag === "Right" && !outcome.right.abstained
        ? outcome.right.skills.filter((id) => candidates.some((skill) => skill.id === id) && !loadedBefore.includes(id))
        : []
      // A multi-label decision: `selection` is the chosen skill ids joined by ",".
      const selection = chosen.length === 0 ? Option.none<string>() : Option.some(chosen.join(","))
      const probabilities = outcome._tag === "Right" ? outcome.right.probabilities : Option.none()
      const record: DecisionRecord = {
        version: 1,
        id: DecisionId.make(`${run.runId}:skill-selection`),
        family: "skill-selection",
        // Hashed under its original key, so decision context hashes are unchanged.
        contextHash: fingerprintOf(canonicalJson({ message: userMessage.text, active: activeNow, history: history.length })),
        candidateHash,
        policyVersion: `${selector.id}@${selector.version}`,
        candidates: candidates.map((skill) => ({ id: skill.id, description: skill.summary })),
        attempts: [],
        selection,
        validation: outcome._tag === "Left" ? "failed" : outcome.right.abstained || chosen.length === 0 ? "abstained" : "accepted",
        fallback: outcome._tag === "Left" ? Option.some(`always-on: ${outcome.left.message}`) : Option.none(),
        applied: selection,
        probabilities,
      }
      return { userMessage, skills: chosen, probabilities, record: Option.some(record) } satisfies SkillMatch
    })

    /** Activate the always-on skills and the match, record the decision, seed the load_skill exchange. */
    const apply = (matched: SkillMatch) => Effect.gen(function* () {
      yield* always.length === 0 ? Effect.void : activate(always, "always").pipe(Effect.asVoid)
      const loaded = yield* Ref.get(loadedSkills)
      const chosen = matched.skills.filter((id) => !loaded.includes(id))
      const applied = yield* chosen.length === 0 ? Effect.succeed(false) : activate(chosen, "matcher").pipe(Effect.as(true), Effect.orElseSucceed(() => false))
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
        const callId = ToolCallId.make(`${run.runId}:matcher`)
        yield* session.recordTail([
          { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: LoadSkill.name, input: { skills: chosen } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: LoadSkill.name, output: skillInstructions(seeded, []), isError: false }] },
        ], views, 0)
      }
      return yield* Ref.get(active)
    })

    const select = (userMessage: UserMessage) => match(userMessage).pipe(Effect.flatMap(apply))

    return {
      toolkit: toolkit as never as Toolkit.Toolkit<Record<string, Tool.Any>>,
      handlers: handlers as Context.Context<never>,
      active: Ref.get(active).pipe(Effect.map((names) => [...own.map((entry) => entry.tool.name), ...names])),
      activate,
      match,
      apply,
      select,
      views,
      pollable: registered.filter((entry) => entry.annotations.pollable).map((entry) => entry.tool.name),
      skills,
    } satisfies RunTools
  })

  return { catalog, open, views, skills }
})

