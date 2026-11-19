// Lesson 16's files, compiled as written, type-checked, and run on the kernel
// with a scripted model over the page's workspace: a read and an edit through
// the file tools, a workspace that declines, a loop that asks before a write,
// and a judge before the person. Each text the lesson derives is checked
// against the text it starts from; the starter, which provides no `Approval`,
// is checked to compile, and a program that leaves out the workspace, or that
// asks and gives nobody to ask, not to.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import type { LanguageModel } from "effect/ai"
import { APPROVAL_REFUSED, Approval, Files, inMemoryFiles, scriptedModel } from "@xandreed/sdk"
import type { ApprovalRequest, Decision, ModelScript } from "@xandreed/sdk"
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, typedModule } from "../base/agent.source.ts"
import { formatRegion } from "../../format.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, FILES_LINES, IMPORTS, JUDGE_TYPED, MERGED, moduleOf, PAGE_GIVES, REPLACED, REPLACED_IMPORTS, TYPED } from "./agent.source.ts"
import { ASK_FIRST, ASKING_LINE, askFirst, JUDGE, JUDGED_LINE, judged, KEEP_DOCS, keepDocs, SLOW_WRITES, slowWrites } from "./config-edit.ts"
import { SEED } from "./lesson.ts"
import { DECLARATION, DEFAULT_WORKSPACE, SANDBOX, workspaceModuleOf } from "./workspace.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)
const root = fileURLToPath(new URL("../../../../", import.meta.url))

interface Shown {
  readonly replies: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
}

const write = (name: string, agent: string = DEFAULT_AGENT, workspace: string = DEFAULT_WORKSPACE) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(agent))
  writeFileSync(new URL("./workspace.ts", at), workspaceModuleOf(workspace))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(DEFAULT_TOOLS))
  return new URL("./agent.ts", at)
}

/** tsc over the files written under `folder`: what it said, and its exit code. */
const compile = (folder: string) => {
  const config = new URL(`./${folder}/tsconfig.json`, dir)
  writeFileSync(config, JSON.stringify({ extends: `${"../".repeat(folder.split("/").length + 5)}tsconfig.learn.json`, include: ["./*/*.ts", "./*.ts"], exclude: [] }))
  const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(config)], { cwd: root })
  return { said: `${checked.stdout.toString()}${checked.stderr.toString()}`, code: checked.exitCode }
}

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (approvalOn: (pane: Pane) => Layer.Layer<Approval>, files: Layer.Layer<Files>, pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/**
 * Run `main` from the module at `file` over a workspace of the page's seed, with the scripted model and a host that
 * answers each question from `answers`, in order, and with a no once they end. `messages` are sent one by one, each
 * once the one before it is answered. What comes back: what was shown, every prompt, every question, and the files.
 */
const runMain = (file: URL, messages: ReadonlyArray<string>, script: ModelScript, answers: ReadonlyArray<Decision> = []) => Effect.gen(function* () {
  const { run }: { readonly run: Run } = yield* Effect.promise(() => import(file.href))
  const { model, calls } = yield* scriptedModel(script)
  // The page's workspace: built once, and given to the program as a value, as the page gives it.
  const built = yield* Layer.build(inMemoryFiles(SEED))
  const workspace = Context.get(built, Files)
  const asked = yield* Ref.make<ReadonlyArray<ApprovalRequest>>([])
  const host = Layer.succeed(Approval, Approval.of({
    ask: (request) => Effect.map(Ref.updateAndGet(asked, (all) => [...all, request]), (all): Decision => answers[all.length - 1] ?? { _tag: "Refused" }),
  }))
  const shown = yield* Ref.make<Shown>({ replies: [], errors: [] })
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  let send: (text: string) => void = () => {}
  const note = (key: keyof Shown, text: string) => Effect.runSync(Ref.update(shown, (all) => ({ ...all, [key]: [...all[key], text] })))
  const answered = () => {
    const count = Effect.runSync(Effect.map(Ref.get(shown), (all) => all.replies.length + all.errors.length))
    const next = messages[count]
    if (next === undefined) Effect.runSync(Deferred.succeed(done, undefined))
    else send(next)
  }
  const pane: Pane = {
    onSend: (given) => { send = given; Effect.runSync(Deferred.succeed(sent, given)) },
    appendToAnswer: () => {},
    finishAnswer: (text) => { note("replies", text); answered() },
    showError: (error) => { note("errors", String(error)); answered() },
    showStatus: () => {},
  }
  const program = yield* Effect.forkChild(run(() => host, Layer.succeed(Files, workspace), pane, model))
  const given = yield* Deferred.await(sent)
  given(messages[0] ?? "")
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  const paths = yield* workspace.list(Option.none())
  const after = Object.fromEntries(yield* Effect.forEach(paths, (path) => Effect.map(Effect.orDie(workspace.read(path)), (text) => [path, text] as const), { concurrency: 1 }))
  return { shown: yield* Ref.get(shown), calls: yield* calls, asked: yield* Ref.get(asked), after }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const SYSTEM = "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."

const calling = (name: string, params: Record<string, string>) => ({ _tag: "Calls" as const, pieces: [], calls: [{ name, params }] })
const says = (text: string) => ({ _tag: "Answers" as const, pieces: [text] })
const TODO = SEED["notes/todo.md"] ?? ""

/** The page's files after a run that changed one: the seed, with that file as given. */
const seedWith = (path: string, text: string) => ({ ...SEED, [path]: text })

describe("lesson 16's displayed program", () => {
  test("the base still holds each piece this lesson replaces in it, and nothing else differs", () => {
    for (const [from] of REPLACED) expect({ from, held: BASE_AGENT.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of REPLACED_IMPORTS) expect({ from, held: BASE_IMPORTS.split(from).length - 1 }).toEqual({ from, held: 1 })
    // agent.ts beside the base: the merged toolkit with its comment, one comment line, and two lines of main.
    const ours = DEFAULT_AGENT.split("\n")
    const base = BASE_AGENT.split("\n")
    expect(ours.filter((line) => !base.includes(line))).toEqual([...MERGED.trimEnd().split("\n"), PAGE_GIVES.trimEnd(), ...FILES_LINES.trimEnd().split("\n")])
    expect(base.filter((line) => !ours.includes(line))).toEqual(["      const toolkit = yield* tools"])
    // The program as it starts asks no one: no Approval is provided, and the loop runs every call as the base does.
    expect(DEFAULT_AGENT).not.toContain("approvalOn(")
    expect(DEFAULT_AGENT).toContain("yield* callTool(toolkit, call, session)")
    // Its imports beside the base's: what the program uses, and the names the experiments use.
    expect(IMPORTS.split("\n").filter((line) => !BASE_IMPORTS.split("\n").includes(line))).toEqual([
      'import { Effect, Layer, Predicate, Result, Stream } from "effect"',
      'import { LanguageModel, Prompt, Toolkit } from "effect/ai"',
      'import { Core, kernel, Sessions, toolResult, turnStartedEvent, userMessage } from "@xandreed/core"',
      'import { Approval, approveIn, callTool, fileHandlers, fileTools, inProcessJournal, Memory, modelAnswer, sessions, workspacePath } from "@xandreed/sdk"',
      'import { workspace } from "./workspace.ts"',
    ])
    // `files` and `approvalOn` are named by no import: they are the page's, and main's comment says so.
    expect(IMPORTS).not.toMatch(/\bfiles\b|approvalOn/)
    expect(documentOf(DEFAULT_AGENT)).toContain(`// \`pane\` and \`model\` come from the page: the chat on the right, and the model you picked.\n${PAGE_GIVES}`)
    // The typed module's pieces are each in the base's typed module once.
    for (const [from] of TYPED) expect({ from, held: typedModule(IMPORTS, DEFAULT_AGENT).split(from).length - 1 }).toEqual({ from, held: 1 })
    expect(JUDGE.split(JUDGE_TYPED[0]).length - 1).toBe(1)
    // workspace.ts as it starts: the sandbox, the function that gives the page's files as they are.
    expect(DEFAULT_WORKSPACE.endsWith(SANDBOX)).toBe(true)
    expect(SANDBOX.endsWith(`${DECLARATION} files`)).toBe(true)
    expect(workspaceModuleOf(DEFAULT_WORKSPACE)).toContain("export const workspace = (files: Layer.Layer<Files>) => files\n")
  })

  test("the seed files: a short list, a guide under docs/, and a file longer than one page", () => {
    expect(Object.keys(SEED)).toEqual(["notes/todo.md", "docs/guide.md", "notes/long.md"])
    expect(TODO).toBe("- buy milk\n- call Ana\n")
    expect(SEED["docs/guide.md"]).toBe("# Guide\n\nThis workspace lives in the page's memory: a reload starts it over.\nThe agent reaches it through four tools, and nothing else.\n")
    expect(SEED["notes/long.md"]?.length).toBe(6246)
  })

  test("each experiment changes the lines it names, and no other; judge is ask-first's change and its own", () => {
    const changed = (before: string, after: string) => ({
      gone: before.split("\n").filter((line) => !after.split("\n").includes(line)),
      come: after.split("\n").filter((line) => !before.split("\n").includes(line)),
    })
    expect(changed(DEFAULT_WORKSPACE, Option.getOrThrow(keepDocs(DEFAULT_WORKSPACE)))).toEqual({ gone: SANDBOX.split("\n"), come: KEEP_DOCS.split("\n").filter((line) => line !== "") })
    expect(changed(DEFAULT_WORKSPACE, Option.getOrThrow(slowWrites(DEFAULT_WORKSPACE)))).toEqual({ gone: SANDBOX.split("\n"), come: SLOW_WRITES.split("\n").filter((line) => line !== "") })
    const asking = Option.getOrThrow(askFirst(DEFAULT_AGENT))
    expect(changed(DEFAULT_AGENT, asking)).toEqual({ gone: [], come: [...ASK_FIRST.trimEnd().split("\n").filter((line) => !DEFAULT_AGENT.split("\n").includes(line)), ASKING_LINE.trimEnd()] })
    // The judge: everything ask-first changes, the line that gives the judge in place of the person, and the judge.
    const judging = Option.getOrThrow(judged(DEFAULT_AGENT))
    expect(changed(asking, judging)).toEqual({ gone: [ASKING_LINE.trimEnd()], come: [...JUDGE.trimEnd().split("\n").filter((line) => !asking.split("\n").includes(line)), JUDGED_LINE.trimEnd()] })
    // A line the learner rewrote is left alone, and an experiment is never half applied.
    expect(keepDocs(DEFAULT_WORKSPACE.replace("(files) => files", "(given) => given"))).toEqual(Option.none())
    expect(askFirst(DEFAULT_AGENT.replace("callTool(toolkit, call, session)", "callTool(toolkit, call, opened)"))).toEqual(Option.none())
    expect(askFirst(DEFAULT_AGENT.replace("Effect.provide(workspace(files))", "Effect.provide(files)"))).toEqual(Option.none())
    expect(judged(DEFAULT_AGENT.replace("// Run it:", "// Start it:"))).toEqual(Option.none())
    // Pressed twice, ask-first changes nothing more; the judge takes the code ask-first left as it takes the starter,
    // and a judge in place already is left alone.
    expect(askFirst(asking)).toEqual(Option.none())
    expect(judged(asking)).toEqual(Option.some(judging))
    expect(judged(judging)).toEqual(Option.none())
  })

  test("each experiment leaves its file as the page's Format button leaves it", async () => {
    const left = [
      Option.getOrThrow(keepDocs(DEFAULT_WORKSPACE)), Option.getOrThrow(slowWrites(DEFAULT_WORKSPACE)),
      Option.getOrThrow(askFirst(DEFAULT_AGENT)), Option.getOrThrow(judged(DEFAULT_AGENT)),
    ]
    for (const text of left) expect(await formatRegion(text, "")).toEqual({ ok: true, text })
  })

  test("each comment line this lesson shows fits 100 columns", () => {
    const shown = [DEFAULT_WORKSPACE, MERGED, PAGE_GIVES, FILES_LINES, KEEP_DOCS, SLOW_WRITES, ASK_FIRST, ASKING_LINE, JUDGE, JUDGED_LINE]
    expect(shown.flatMap((text) => text.split("\n")).filter((line) => line.trim().startsWith("//") && line.length > 100)).toEqual([])
  })

  test("a read and an edit over the page's workspace: the model reads a page, the edit changes the file, and nothing is asked", async () => {
    const result = await Effect.runPromise(runMain(write("read-edit"), ["Move the call to noon."], [
      calling("readFile", { path: "notes/todo.md" }),
      calling("editFile", { path: "notes/todo.md", find: "call Ana", replace: "call Ana at noon" }),
      says("Done."),
    ]))
    expect(result.shown).toEqual({ replies: ["Done."], errors: [] })
    expect(result.asked).toEqual([])
    // The model was offered every tool, and read the file as a page: the result is what the next prompt holds.
    expect(result.calls[1]).toEqual([
      { role: "system", text: SYSTEM },
      { role: "user", text: "Move the call to noon." },
      { role: "assistant", text: 'readFile({"path":"notes/todo.md"})' },
      { role: "tool", text: `→ ${JSON.stringify({ path: "notes/todo.md", text: TODO, from: 0, to: 22, total: 22 })}` },
    ])
    expect(result.calls[2]?.at(-1)).toEqual({ role: "tool", text: '→ {"path":"notes/todo.md","characters":30}' })
    expect(result.after).toEqual(seedWith("notes/todo.md", "- buy milk\n- call Ana at noon\n"))
  })

  test("with keep-docs (an experiment), a write under docs/ is declined in the kernel's words and the file is unchanged; another write goes through", async () => {
    const result = await Effect.runPromise(runMain(write("keep-docs", DEFAULT_AGENT, Option.getOrThrow(keepDocs(DEFAULT_WORKSPACE))), ["Write both."], [
      calling("writeFile", { path: "docs/guide.md", text: "gone" }),
      calling("writeFile", { path: "a.txt", text: "kept" }),
      says("Done."),
    ]))
    expect(result.calls[1]?.at(-1)).toEqual({
      role: "tool",
      text: `→ failed: ${JSON.stringify('The workspace declined this for docs/guide.md: "the docs folder is read-only". Do not try it again unless the user asks for it.')}`,
    })
    expect(result.after).toEqual({ ...SEED, "a.txt": "kept" })
  })

  test("with ask-first (an experiment), the loop asks before a write, keyed by the file: a no is the call's result, Always stands for that file only", async () => {
    const writing = (path: string, text: string) => calling("writeFile", { path, text })
    const result = await Effect.runPromise(runMain(write("ask-first", Option.getOrThrow(askFirst(DEFAULT_AGENT))), ["One.", "Two.", "Three."], [
      calling("readFile", { path: "notes/todo.md" }), writing("a.txt", "one"), says("Not written."),
      writing("a.txt", "two"), writing("a.txt", "three"), says("Written twice."),
      writing("b.txt", "four"), calling("writeFile", { path: "../out.txt", text: "x" }), says("Done."),
    ], [{ _tag: "Refused" }, { _tag: "ApprovedAlways" }, { _tag: "Approved" }]))
    expect(result.shown.errors).toEqual([])
    // A read is not asked about; a.txt is asked about twice (refused, then for good), b.txt once, and a path that is none never.
    expect(result.asked).toEqual([
      { action: "files.write:a.txt", detail: "Let the agent write a.txt." },
      { action: "files.write:a.txt", detail: "Let the agent write a.txt." },
      { action: "files.write:b.txt", detail: "Let the agent write b.txt." },
    ])
    expect(result.calls[2]?.at(-1)).toEqual({ role: "tool", text: `→ failed: ${JSON.stringify(APPROVAL_REFUSED)}` })
    expect(result.calls[8]?.at(-1)).toMatchObject({ role: "tool", text: expect.stringContaining("is not a path in the workspace") })
    expect(result.after).toEqual({ ...SEED, "a.txt": "three", "b.txt": "four" })
  })

  test("with judge (an experiment), a write under scratch/ is allowed with nobody asked, and any other goes to the person", async () => {
    const result = await Effect.runPromise(runMain(write("judge", Option.getOrThrow(judged(DEFAULT_AGENT))), ["Write both."], [
      calling("writeFile", { path: "scratch/a.txt", text: "x" }),
      calling("writeFile", { path: "notes.md", text: "y" }),
      says("Done."),
    ], [{ _tag: "Approved" }]))
    expect(result.asked).toEqual([{ action: "files.write:notes.md", detail: "Let the agent write notes.md." }])
    expect(result.after).toEqual({ ...SEED, "scratch/a.txt": "x", "notes.md": "y" })
  })

  test("type-checks as TypeScript, every file, as shown and as each experiment leaves them: the starter provides no Approval", () => {
    write("typed/shown")
    write("typed/keep-docs", DEFAULT_AGENT, Option.getOrThrow(keepDocs(DEFAULT_WORKSPACE)))
    write("typed/slow-writes", DEFAULT_AGENT, Option.getOrThrow(slowWrites(DEFAULT_WORKSPACE)))
    write("typed/ask-first", Option.getOrThrow(askFirst(DEFAULT_AGENT)))
    write("typed/judge", Option.getOrThrow(judged(DEFAULT_AGENT)))
    const checked = compile("typed")
    expect(checked.said).toBe("")
    expect(checked.code).toBe(0)
  }, 120_000)

  test("type-level: a program that leaves out the workspace does not compile, and the compiler names Files", () => {
    write("missing-files/x", DEFAULT_AGENT.replace(FILES_LINES.split("\n")[1] ?? "", "  // No workspace is given here."))
    const checked = compile("missing-files")
    expect(checked.code).not.toBe(0)
    expect(checked.said).toContain("agent.ts")
    expect(checked.said).toContain("Type 'Files' is not assignable to type 'never'")
    expect(checked.said.split("\n").filter((line) => line.includes("error TS"))).toHaveLength(1)
  }, 120_000)

  test("type-level: a loop that asks before a write, with no Approval given, does not compile, and the compiler names Approval", () => {
    write("missing-approval/x", Option.getOrThrow(askFirst(DEFAULT_AGENT)).replace(ASKING_LINE, ""))
    const checked = compile("missing-approval")
    expect(checked.code).not.toBe(0)
    expect(checked.said).toContain("agent.ts")
    expect(checked.said).toContain("Type 'Approval' is not assignable to type 'never'")
    expect(checked.said.split("\n").filter((line) => line.includes("error TS"))).toHaveLength(1)
  }, 120_000)
})
