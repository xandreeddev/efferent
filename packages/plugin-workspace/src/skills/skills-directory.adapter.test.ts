import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Capabilities, defineCapability, defineSkill, FileSystem, RunId, SessionEnvironment, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { Capability, SessionLogEvent, SkillDefinition } from "@xandreed/core"
import { Journey } from "@xandreed/evals"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { activateGraph, resolveGraph } from "@xandreed/runtime"
import { Agent } from "@xandreed/sdk"
import { FileSystemLive } from "../file-system.adapter.js"
import { localSystemPlugin } from "../plugin.adapter.js"
import { skillsDirectoryPlugin, SkillsDirectoryPluginLive } from "./skills-directory.adapter.js"
import type { SkillsDirectoryConfig } from "./skills-directory.entity.js"

/* ── a workspace on disk ── */

type Tree = Readonly<Record<string, string>>

/** A fresh directory holding `tree` (paths relative to it), removed with the scope. */
const workspaceWith = (tree: Tree) => Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(join(tmpdir(), "efferent-skills-"))
    await Promise.all(Object.entries(tree).map(async ([path, text]) => {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }))
    return root
  }),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
)

const skillMd = (fields: string, body = "") => `---\n${fields}\n---\n${body}`

const projectSkills: Tree = {
  ".agents/skills/commit-style/SKILL.md": skillMd("name: commit-style\ndescription: How to write a commit message here.", "Lowercase, verb-led titles. See references/examples.md."),
  ".agents/skills/commit-style/references/examples.md": "# Commit examples\n\nadd the skills directory loader",
  ".agents/skills/release/SKILL.md": skillMd("description: Cutting a release.\nalways: true", "Never publish without sign-off."),
  ".agents/skills/release/checklist/SKILL.md": skillMd("description: The release checklist.", "1. Bump versions."),
  ".agents/skills/release/checklist/steps.md": "# Steps\n\nbuild, verify, publish",
  ".agents/skills/README.md": "Not a skill: outside every skill directory.",
}

/** The skills the plugin contributes over the local disk, as the graph activates it. */
const contributed = (workspace: string, options: Partial<SkillsDirectoryConfig> = {}) => Effect.gen(function* () {
  const graph = yield* resolveGraph({ version: 1, plugins: [{ id: "skills", use: skillsDirectoryPlugin.id, options }] }, [skillsDirectoryPlugin], [FileSystem.key, SessionEnvironment.key])
  const seed = Context.make(FileSystem, yield* FileSystem.pipe(Effect.provide(FileSystemLive))).pipe(Context.add(SessionEnvironment, { workspace }))
  const context = yield* activateGraph(graph, "runtime", Context.makeUnsafe<never>(seed.mapUnsafe), yield* Effect.scope)
  return Option.getOrElse(Context.getOption(context, Capabilities), (): ReadonlyArray<Capability> => [])
})
const skillsIn = (capabilities: ReadonlyArray<Capability>): ReadonlyArray<SkillDefinition> => capabilities.flatMap((capability) => capability.skills)
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))
const failureOf = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(Effect.flip(effect)))

describe("skillsDirectoryPlugin over the local disk", () => {
  test("reads every SKILL.md under the workspace's .agents/skills, nested ones too, by the id rule", async () => {
    const skills = await run(workspaceWith(projectSkills).pipe(Effect.flatMap((workspace) => contributed(workspace)), Effect.map(skillsIn)))
    expect(skills.map((skill) => [skill.id, skill.summary, skill.always, skill.references.map((reference) => reference.id)])).toEqual([
      ["commit-style", "How to write a commit message here.", false, ["references/examples.md"]],
      ["release", "Cutting a release.", true, []],
      ["release/checklist", "The release checklist.", false, ["steps.md"]],
    ])
  })

  test("a SKILL.md at a root is named after the root; an absolute root is read as it is; idPrefix goes before every id", async () => {
    const skills = await run(Effect.gen(function* () {
      const other = yield* workspaceWith({ "team-notes/SKILL.md": skillMd("description: Team notes.") })
      const workspace = yield* workspaceWith(projectSkills)
      return skillsIn(yield* contributed(workspace, { roots: [join(other, "team-notes"), ".agents/skills/release"], idPrefix: "ws." }))
    }))
    expect(skills.map((skill) => skill.id)).toEqual(["ws.team-notes", "ws.release", "ws.checklist"])
  })

  test("a missing root is skipped unless required (skills.root); declared tools are dropped unless tools: declared", async () => {
    const { skipped, missing, declared, ignored } = await run(Effect.gen(function* () {
      const workspace = yield* workspaceWith({ "skills/a/SKILL.md": skillMd("description: A.\ntools: lookup") })
      return {
        skipped: skillsIn(yield* contributed(workspace, { roots: ["nowhere", "skills"] })).map((skill) => skill.id),
        missing: yield* Effect.flip(contributed(workspace, { roots: ["nowhere"], required: true })),
        declared: skillsIn(yield* contributed(workspace, { roots: ["skills"], tools: "declared" }))[0]?.tools,
        ignored: skillsIn(yield* contributed(workspace, { roots: ["skills"] }))[0]?.tools,
      }
    }))
    expect(skipped).toEqual(["a"])
    expect([missing.code, missing.message.endsWith("nowhere does not exist (required)")]).toEqual(["skills.root", true])
    expect([declared, ignored]).toEqual([["lookup"], []])
  })

  test("strict fails on a bad SKILL.md with skills.files; lenient leaves that skill out and loads the rest", async () => {
    const tree = { "skills/good/SKILL.md": skillMd("description: Good."), "skills/bad/SKILL.md": "no frontmatter at all" }
    const { strict, lenient } = await run(workspaceWith(tree).pipe(Effect.flatMap((workspace) => Effect.all({
      strict: Effect.flip(contributed(workspace, { roots: ["skills"], strict: true })),
      lenient: contributed(workspace, { roots: ["skills"] }).pipe(Effect.map(skillsIn)),
    }))))
    expect([strict.code, strict.message.includes("bad/SKILL.md: no frontmatter")]).toEqual(["skills.files", true])
    expect(lenient.map((skill) => skill.id)).toEqual(["good"])
  })

  test("limits fail the plugin's activation with skills.limit, naming the limit; a reference over maxReferenceBytes is not counted", async () => {
    const tree = { "skills/a/SKILL.md": skillMd("description: A."), "skills/b/SKILL.md": skillMd("description: B."), "skills/b/big.md": "x".repeat(400) }
    const { codes, uncounted } = await run(workspaceWith(tree).pipe(Effect.flatMap((workspace) => Effect.all({
      codes: Effect.forEach([{ maxFiles: 2 }, { maxBytes: 300 }, { maxSkills: 1 }], (limit) => Effect.flip(contributed(workspace, { roots: ["skills"], ...limit })).pipe(
        Effect.map((error) => [error.code, /\((maxFiles|maxBytes|maxSkills)\)$/.exec(error.message)?.[1]]))),
      uncounted: contributed(workspace, { roots: ["skills"], maxBytes: 300, maxReferenceBytes: 100 }).pipe(Effect.map(skillsIn)),
    }))))
    expect(codes).toEqual([["skills.limit", "maxFiles"], ["skills.limit", "maxBytes"], ["skills.limit", "maxSkills"]])
    expect(uncounted.map((skill) => [skill.id, skill.references.length])).toEqual([["a", 0], ["b", 0]])
  })

  test("a limit fails Agent.define with skills.limit as it is, not plugin.activation", async () => {
    const error = await failureOf(workspaceWith(projectSkills).pipe(Effect.flatMap((workspace) => define(workspace, { maxSkills: 1 }))))
    expect([error.code, error.message]).toEqual(["skills.limit", "found 3 skills, more than 1 (maxSkills)"])
  })

  test("is a typed layer too: relative roots resolve against SessionEnvironment when present, the working directory otherwise", async () => {
    const { withEnvironment, withoutEnvironment } = await run(Effect.gen(function* () {
      const workspace = yield* workspaceWith(projectSkills)
      const idsOf = <E>(layer: Layer.Layer<Capabilities, E>) => Layer.build(layer).pipe(Effect.map((context) => skillsIn(Context.get(context, Capabilities)).map((skill) => skill.id)))
      return {
        withEnvironment: yield* idsOf(SkillsDirectoryPluginLive({ roots: [".agents/skills/commit-style"] }).pipe(
          Layer.provide(Layer.merge(FileSystemLive, Layer.succeed(SessionEnvironment, { workspace }))))),
        // No SessionEnvironment: a root relative to the process's working directory.
        withoutEnvironment: yield* idsOf(SkillsDirectoryPluginLive({ roots: [relative(process.cwd(), join(workspace, ".agents/skills/release"))] }).pipe(
          Layer.provide(FileSystemLive))),
      }
    }))
    expect([withEnvironment, withoutEnvironment]).toEqual([["commit-style"], ["release", "checklist"]])
  })
})

/* ── agents over the directory, with a scripted model ── */

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 1 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]

/** A model that answers with `script`, one response per request, recording each request's prompt. */
const scripted = (script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const prompts = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(prompts, (all): [number, ReadonlyArray<string>] => [all.length, [...all, JSON.stringify(options.prompt.content)]])
      .pipe(Effect.map((index) => (script[index] ?? stop("done")) as never)),
    streamText: () => Stream.die("not scripted") as never,
  })
  return { prompts, model }
})

const define = (workspace: string, options: Partial<SkillsDirectoryConfig> = {}, capabilities: ReadonlyArray<Capability> = []) => Agent.define({
  plugins: [localSystemPlugin, { plugin: skillsDirectoryPlugin, options }, memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
  capabilities,
  turnServices: [LanguageModel.LanguageModel],
  limits: { streaming: false, maxSteps: 6 },
  workspace,
  system: "You answer questions about this repository.",
})

/** A session in memory and a way to run one turn of the agent in it. */
const conversation = Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const view = yield* sessions.create({ owner: "test" })
  const address = { id: view.header.id, owner: "test" }
  return { sessions, address, stored: sessions.read(address).pipe(Effect.orDie) }
})

const turnOf = (agent: Agent, journal: Effect.Success<typeof conversation>, runId: string, text: string, model: LanguageModel.LanguageModel) => agent.turn({
  turn: { session: journal.address, userMessage: new UserMessage({ text }), runId: RunId.make(runId) },
  services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, journal.sessions)),
}, (turn) => Effect.gen(function* () {
  yield* turn.tools.select(turn.userMessage)
  const result = yield* turn.run({})
  return { outcome: result.outcome, reply: Option.some(result.text) }
}))

/** What the model was shown for each tool call: the tool, whether it failed, and the text. */
const toolResults = (events: ReadonlyArray<SessionLogEvent>, runId: string) => events
  .filter((event) => event.kind === "memory.tool-result" && event.data.runId === runId)
  .map((event) => event.data.body as { readonly toolName: string; readonly isError: boolean; readonly view: string })
  .map((body) => [body.toolName, body.isError ? "failed" : "ok", body.view] as const)

describe("an agent over the skills directory", () => {
  test("lists the skills, and the model loads one with load_skill and reads its reference with read_skill_reference", async () => {
    const seen = await run(Effect.gen(function* () {
      const workspace = yield* workspaceWith(projectSkills)
      const agent = yield* define(workspace)
      const journal = yield* conversation
      const { prompts, model } = yield* scripted([
        call("c1", "load_skill", { skills: ["commit-style"] }),
        call("c2", "read_skill_reference", { skill: "commit-style", reference: "references/examples.md" }),
        stop("add the skills directory loader"),
      ])
      const outcome = yield* turnOf(agent, journal, "run-1", "How do I title a commit here?", model)
      return { outcome, prompts: yield* Ref.get(prompts), results: toolResults(yield* journal.stored, "run-1") }
    }))
    expect(seen.outcome.reply).toEqual(Option.some("add the skills directory loader"))
    const system = seen.prompts[0] ?? ""
    expect(system).toContain("- commit-style: How to write a commit message here.")
    expect(system).toContain("- release/checklist: The release checklist.")
    // The always-on skill is not in the catalogue: its instructions are in the plugin's section.
    expect(system).not.toContain("- release: Cutting a release.")
    expect(system).toContain("### release\\nNever publish without sign-off.")
    expect(seen.results).toEqual([
      ["load_skill", "ok", "## commit-style\nLowercase, verb-led titles. See references/examples.md.\nReferences (read_skill_reference): references/examples.md — Commit examples"],
      ["read_skill_reference", "ok", "# Commit examples\n\nadd the skills directory loader"],
    ])
  })

  test("a skill id the host also defines fails Agent.define with skills.duplicate; idPrefix resolves it", async () => {
    const host = defineCapability({ id: "host", version: "1", skills: [defineSkill({ id: "commit-style", summary: "The host's own.", tools: [] })] })
    const { clash, prefixed } = await run(Effect.gen(function* () {
      const workspace = yield* workspaceWith(projectSkills)
      return {
        clash: yield* Effect.flip(Effect.scoped(define(workspace, {}, [host]))),
        prefixed: yield* Effect.scoped(define(workspace, { idPrefix: "project." }, [host]).pipe(Effect.as("defined"))),
      }
    }))
    expect([clash.code, clash.message]).toEqual(["skills.duplicate", "Two capabilities define the skill commit-style"])
    expect(prefixed).toBe("defined")
  })

  test("a declared tool no capability registers fails Agent.define with skills.tools", async () => {
    const error = await failureOf(workspaceWith({ ".agents/skills/a/SKILL.md": skillMd("description: A.\ntools: no_such_tool") }).pipe(
      Effect.flatMap((workspace) => define(workspace, { tools: "declared" }))))
    expect([error.code, error.message]).toEqual(["skills.tools", "Skills reference unregistered tools: a → no_such_tool"])
  })
})

/* ── the journey: a conversation that leans on file skills, turn after turn ── */

const Action = Schema.Struct({ user: Schema.String, script: Schema.Array(Schema.Array(Schema.Unknown)) })

/**
 * A key-free journey: the fixture is a workspace's skills directory, each
 * action a user message and what the scripted model answers in that turn.
 * Each turn's observation is its reply and the tool results the model saw.
 */
const skillsJourney = Schema.decodeUnknownSync(Journey)({
  id: "skills-directory",
  version: "1",
  fixture: projectSkills,
  actions: [
    { id: "load", action: { user: "How should I title this commit?", script: [call("a1", "load_skill", { skills: ["commit-style"] }), stop("Lowercase and verb-led.")] } },
    { id: "reference", action: { user: "Show me an example.", script: [call("b1", "read_skill_reference", { skill: "commit-style", reference: "references/examples.md" }), stop("add the skills directory loader")] } },
    { id: "not-loaded", action: { user: "What are the release steps?", script: [
      call("c1", "read_skill_reference", { skill: "release/checklist", reference: "steps.md" }),
      call("c2", "load_skill", { skills: ["release/checklist"] }),
      call("c3", "read_skill_reference", { skill: "release/checklist", reference: "steps.md" }),
      stop("build, verify, publish"),
    ] } },
  ],
})

describe("journey: skills from a directory", () => {
  test("a loaded skill stays loaded across turns; a reference of an unloaded skill is refused until it is loaded", async () => {
    const observed = await run(Effect.gen(function* () {
      const workspace = yield* workspaceWith(skillsJourney.fixture as Tree)
      const agent = yield* define(workspace)
      const journal = yield* conversation
      return yield* Effect.forEach(skillsJourney.actions, ({ id, action }) => Effect.gen(function* () {
        const { user, script } = Schema.decodeUnknownSync(Action)(action)
        const { model } = yield* scripted(script)
        const outcome = yield* turnOf(agent, journal, id, user, model)
        return { id: String(id), reply: Option.getOrNull(outcome.reply), tools: toolResults(yield* journal.stored, id).map(([tool, status, view]) => [tool, status, view.split("\n")[0]]) }
      }))
    }))
    expect(observed).toEqual([
      { id: "load", reply: "Lowercase and verb-led.", tools: [["load_skill", "ok", "## commit-style"]] },
      { id: "reference", reply: "add the skills directory loader", tools: [["read_skill_reference", "ok", "# Commit examples"]] },
      { id: "not-loaded", reply: "build, verify, publish", tools: [
        ["read_skill_reference", "failed", expect.stringContaining("Load release/checklist with load_skill first")],
        ["load_skill", "ok", "## release/checklist"],
        ["read_skill_reference", "ok", "# Steps"],
      ] },
    ])
  })
})
