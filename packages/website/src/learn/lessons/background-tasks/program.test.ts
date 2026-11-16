// Lesson 17's files, compiled as written, type-checked, and run on the kernel
// with a scripted model: a task started, which a helper works on in a session
// of its own while the turn that started it ends, and its report answered in a
// turn of its own after. Each text the lesson derives is checked against the
// text it starts from; the starter and each experiment are checked to
// compile, and a program that leaves out the tasks plugin, or where a report
// goes, not to. The helper is held on a signal, never on time: the module a
// test compiles takes its wait from a file the test writes.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import type { LanguageModel } from "effect/ai"
import { SessionId } from "@xandreed/core/kernel"
import { reportText, scriptedModel, TaskId, TaskReports } from "@xandreed/sdk/kernel"
import type { ModelScript, TaskReport } from "@xandreed/sdk/kernel"
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, typedModule } from "../base/agent.source.ts"
import { formatRegion } from "../../format.ts"
import { CHAT as LESSON_1_CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import {
  CHAT_HOOK, DEFAULT_AGENT, documentOf, IMPORTS, INPUT_TURN, MERGED, moduleOf, ON_EACH_INPUT, PAGE_GIVES, REPLACED, REPLACED_IMPORTS, STORE_INPUT, TASK_LINES, TASKS_LINE, TYPED,
} from "./agent.source.ts"
import { CHAT, REPLACED as CHAT_REPLACED } from "./chat.source.ts"
import { instant, ONE_AT_A_TIME_LINE, oneAtATime } from "./config-edit.ts"
import { DECLARATION, DEFAULT_HELPER, helperModuleOf, WAIT } from "./helper.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const root = fileURLToPath(new URL("../../../../", import.meta.url))

/** What a test's helper waits on, in place of its wait: a signal the test gives, never a time. */
const HOLD = `import { Deferred, Effect } from "effect"

export const gate = Deferred.makeUnsafe<void>()
export const hold: Effect.Effect<void> = Deferred.await(gate)
`

/**
 * A probe of chat.ts as shown, over the kernel's own sessions: through the pane, a message, a report and a message;
 * then what `inputs` and `drain` give, in turn.
 */
const PROBE = `import { Effect, Stream } from "effect"
import { kernel } from "@xandreed/core/kernel"
import { inProcessJournal, sessions } from "@xandreed/sdk/kernel"
import type { TaskReport } from "@xandreed/sdk/kernel"
import { Chat, chatOn } from "./chat.ts"
import type { ChatPane } from "./chat.ts"

export const probe = (report: TaskReport) => {
  let send: (text: string) => void = () => {}
  let hand: (report: TaskReport) => void = () => {}
  const pane: ChatPane = {
    onSend: (given) => { send = given },
    onReport: (given) => { hand = given },
    appendToAnswer: () => {},
    finishAnswer: () => {},
    showError: () => {},
    showStatus: () => {},
  }
  return Effect.gen(function* () {
    const chat = yield* Chat
    send("a")
    hand(report)
    send("b")
    const first = yield* Stream.runHead(chat.inputs)
    const drained = yield* chat.drain
    const next = yield* Stream.runHead(chat.inputs)
    const after = yield* chat.drain
    return { first, drained, next, after }
  }).pipe(Effect.provide(chatOn(pane)), Effect.provide(sessions()), Effect.provide(inProcessJournal()), Effect.provide(kernel()))
}
`

/** helper.ts as a test compiles it to hold it: its wait is the hold of the file the test writes. */
const heldModuleOf = (helper: string): string =>
  helperModuleOf(helper).replace('import type { OpenSession } from "@xandreed/core/kernel"\n', 'import type { OpenSession } from "@xandreed/core/kernel"\nimport { hold } from "./hold.ts"\n').replace(WAIT, "    yield* hold\n")

const write = (name: string, agent: string = DEFAULT_AGENT, helper: string = DEFAULT_HELPER, held = false) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(agent))
  writeFileSync(new URL("./helper.ts", at), held ? heldModuleOf(helper) : helperModuleOf(helper))
  writeFileSync(new URL("./hold.ts", at), HOLD)
  writeFileSync(new URL("./probe.ts", at), PROBE)
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(DEFAULT_TOOLS))
  return at
}

/** tsc over the files written under `folder`: what it said, and its exit code. */
const compile = (folder: string) => {
  const config = new URL(`./${folder}/tsconfig.json`, dir)
  writeFileSync(config, JSON.stringify({ extends: `${"../".repeat(folder.split("/").length + 5)}tsconfig.learn.json`, include: ["./*/*.ts", "./*.ts"], exclude: [] }))
  const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(config)], { cwd: root })
  return { said: `${checked.stdout.toString()}${checked.stderr.toString()}`, code: checked.exitCode }
}

type Pane = {
  readonly onSend: (send: (text: string) => void) => void
  readonly onReport: (report: (report: TaskReport) => void) => void
  readonly appendToAnswer: (piece: string) => void
  readonly finishAnswer: (text: string) => void
  readonly showError: (error: unknown) => void
  readonly showStatus: (text: string) => void
}
type Run = (reportsOn: (pane: Pane) => Layer.Layer<TaskReports>, pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/**
 * Run `main` from the module in `folder` with the scripted model: `message` is sent, and once it is answered the
 * helper's hold is let go; the run goes on until `replies` answers were shown. The host's part for reports hands each
 * one to the chat through its pane, as the page's `reportsOn(pane)` does. What comes back: what was shown, and every
 * prompt the model was sent, in order.
 */
const runMain = (folder: URL, message: string, script: ModelScript, replies: number) => Effect.gen(function* () {
  const { run }: { readonly run: Run } = yield* Effect.promise(() => import(new URL("./agent.ts", folder).href))
  const { gate }: { readonly gate: Deferred.Deferred<void> } = yield* Effect.promise(() => import(new URL("./hold.ts", folder).href))
  const { model, calls } = yield* scriptedModel(script)
  const shown = yield* Ref.make<ReadonlyArray<string>>([])
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  let report: (report: TaskReport) => void = () => {}
  const said = (text: string) => {
    const all = Effect.runSync(Ref.updateAndGet(shown, (now) => [...now, text]))
    // The turn that started the task has answered: the helper may go on now.
    if (all.length === 1) Effect.runSync(Deferred.succeed(gate, undefined))
    if (all.length >= replies) Effect.runSync(Deferred.succeed(done, undefined))
  }
  const pane: Pane = {
    onSend: (given) => { Effect.runSync(Deferred.succeed(sent, given)) },
    onReport: (given) => { report = given },
    appendToAnswer: () => {},
    finishAnswer: said,
    showError: (error) => said(`error: ${String(error)}`),
    showStatus: () => {},
  }
  const reportsOn = () => Layer.succeed(TaskReports, TaskReports.of({ deliver: (one) => Effect.sync(() => report(one)) }))
  const program = yield* Effect.forkChild(run(reportsOn, pane, model))
  ;(yield* Deferred.await(sent))(message)
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), calls: yield* calls }
}).pipe(Effect.timeout("10 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const SYSTEM = "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."
const HELPER_SYSTEM = "You are a helper. Do the task you are given, using a tool when it helps, then answer in one short sentence."

const calling = (name: string, params: Record<string, string | number>) => ({ _tag: "Calls" as const, pieces: [], calls: [{ name, params }] })
const says = (text: string) => ({ _tag: "Answers" as const, pieces: [text] })

const times = (text: string, piece: string) => text.split(piece).length - 1

describe("lesson 17's displayed program", () => {
  test("the base still holds each piece this lesson replaces in it, and lesson 1's chat.ts each piece chat.ts replaces", () => {
    for (const [from] of REPLACED) expect({ from, held: times(BASE_AGENT, from) }).toEqual({ from, held: 1 })
    for (const [from] of REPLACED_IMPORTS) expect({ from, held: times(BASE_IMPORTS, from) }).toEqual({ from, held: 1 })
    for (const [from] of CHAT_REPLACED) expect({ from, held: times(LESSON_1_CHAT, from) }).toEqual({ from, held: 1 })
    // The typed module's pieces are each in the base's typed module once.
    for (const [from] of TYPED) expect({ from, held: times(typedModule(IMPORTS, DEFAULT_AGENT), from) }).toEqual({ from, held: 1 })
  })

  test("agent.ts beside the base: the input a turn takes, the merged toolkit, a report stored with taskReport, the hook, the loop over inputs, and main's lines", () => {
    const ours = DEFAULT_AGENT.split("\n")
    const base = BASE_AGENT.split("\n")
    const added = [INPUT_TURN, MERGED, STORE_INPUT, CHAT_HOOK, ON_EACH_INPUT, PAGE_GIVES, TASK_LINES].flatMap((piece) => piece.trimEnd().split("\n")).filter((line) => !base.includes(line))
    expect(ours.filter((line) => !base.includes(line))).toEqual(added)
    expect(base.filter((line) => !ours.includes(line))).toEqual([
      "// One turn: a loop. The model answers, or asks for tools; their results are stored,",
      "// and the model is asked again.",
      "const turn = (message) =>",
      "      const toolkit = yield* tools",
      "      const session = yield* sessions.open(chat.session)",
      "      // Store your message, and every one that waited behind it: this turn answers them all.",
      "      for (const text of [message, ...waiting]) {",
      "    // On boot: hook an event, as a Neovim autocmd would. Here, the chat's status line names each turn.",
      "    yield* core.on(turnStartedEvent, ({ data }) => chat.status(`turn ${data.turn}`), {",
      "      name: \"boot\",",
      "      wait: true,",
      "    })",
      "    // Then, on each message you send: one turn, in order.",
      "    yield* Stream.runForEach(chat.messages, (message) =>",
      "      turn(message).pipe(",
    ])
    // The loop's one change: a report is stored with taskReport, in the session that started the task.
    expect(DEFAULT_AGENT).toContain("input._tag === \"Report\" ? taskReport(input.report) : userMessage(input.text)")
    expect(DEFAULT_AGENT).toContain("input._tag === \"Report\" ? input.report.parent : chat.session")
    expect(DEFAULT_AGENT).toContain(TASKS_LINE)
    // The task lines come before tools.ts's handlers: the helper's calls use them too.
    expect(DEFAULT_AGENT).toContain(`${TASK_LINES}  Effect.provide(toolsLive), // what each tool does when it is called\n`)
    // Its imports beside the base's.
    expect(IMPORTS.split("\n").filter((line) => !BASE_IMPORTS.split("\n").includes(line))).toEqual([
      'import { LanguageModel, Prompt, Toolkit } from "effect/ai"',
      'import { callTool, inProcessJournal, Memory, modelAnswer, sessions, taskHandlers, taskReport, tasks, taskTools } from "@xandreed/sdk/kernel"',
      'import { helper } from "./helper.ts"',
    ])
    // `reportsOn` is named by no import: it is the page's, and main's comment says so.
    expect(IMPORTS).not.toContain("reportsOn")
    expect(documentOf(DEFAULT_AGENT)).toContain(`// \`pane\` and \`model\` come from the page: the chat on the right, and the model you picked.\n${PAGE_GIVES}`)
  })

  test("helper.ts: its wait is its own line, and its typed module types the session and the task as a TaskRun's", () => {
    expect(times(DEFAULT_HELPER, WAIT)).toBe(1)
    expect(WAIT).toContain('yield* Effect.sleep("3 seconds")')
    expect(times(DEFAULT_HELPER, DECLARATION)).toBe(1)
    expect(helperModuleOf(DEFAULT_HELPER)).toContain("export const helper = (session: OpenSession, task: string) =>\n")
    // A small loop over tools.ts's tools, on the kernel's two functions, a few steps at most; the wait comes first.
    expect(DEFAULT_HELPER).toContain("const toolkit = yield* tools")
    expect(DEFAULT_HELPER).toContain("yield* callTool(toolkit, call, session)")
    expect(DEFAULT_HELPER).toContain("const HELPER_STEPS = 3")
    expect(DEFAULT_HELPER.indexOf(WAIT)).toBeLessThan(DEFAULT_HELPER.indexOf("for (let step = 1; step <= HELPER_STEPS; step++)"))
    // The held module a test compiles differs by its wait alone.
    expect(heldModuleOf(DEFAULT_HELPER)).toContain("    yield* hold\n")
    expect(heldModuleOf(DEFAULT_HELPER)).not.toContain("Effect.sleep")
  })

  test("each experiment changes the lines it names, and no other; a line the learner rewrote is left alone", () => {
    const changed = (before: string, after: string) => ({
      gone: before.split("\n").filter((line) => !after.split("\n").includes(line)),
      come: after.split("\n").filter((line) => !before.split("\n").includes(line)),
    })
    expect(changed(DEFAULT_HELPER, Option.getOrThrow(instant(DEFAULT_HELPER)))).toEqual({ gone: WAIT.trimEnd().split("\n"), come: [] })
    expect(changed(DEFAULT_AGENT, Option.getOrThrow(oneAtATime(DEFAULT_AGENT)))).toEqual({ gone: [TASKS_LINE.trimEnd()], come: [ONE_AT_A_TIME_LINE.trimEnd()] })
    expect(instant(DEFAULT_HELPER.replace('Effect.sleep("3 seconds")', 'Effect.sleep("5 seconds")'))).toEqual(Option.none())
    expect(oneAtATime(DEFAULT_AGENT.replace("tasks(helper)", "tasks(myHelper)"))).toEqual(Option.none())
  })

  test("each starter and each experiment leaves its file as the page's Format button leaves it", async () => {
    const texts = [DEFAULT_AGENT, DEFAULT_HELPER, Option.getOrThrow(instant(DEFAULT_HELPER)), Option.getOrThrow(oneAtATime(DEFAULT_AGENT))]
    for (const text of texts) expect(await formatRegion(text, "")).toEqual({ ok: true, text })
  })

  test("each comment line this lesson shows fits 100 columns", () => {
    // The lines this lesson adds to the base's text (the base's own are lesson 2's), helper.ts and chat.ts.
    const base = BASE_AGENT.split("\n")
    const shown = [DEFAULT_AGENT.split("\n").filter((line) => !base.includes(line)).join("\n"), DEFAULT_HELPER, CHAT, ONE_AT_A_TIME_LINE]
    expect(shown.flatMap((text) => text.split("\n")).filter((line) => line.trim().startsWith("//") && line.length > 100)).toEqual([])
    // No cast, and no type written out, in the JavaScript a learner edits.
    expect(`${DEFAULT_AGENT}\n${DEFAULT_HELPER}`).not.toMatch(/\bas (?:never|any|unknown|const)\b|: (?:string|number|unknown)\b/)
  })

  test("chat.ts as shown: inputs gives a message or a report in the order they came; drain takes the messages and leaves the reports", async () => {
    const folder = write("probe")
    type Probe = { readonly probe: (report: TaskReport) => Effect.Effect<{ readonly first: Option.Option<unknown>; readonly drained: ReadonlyArray<string>; readonly next: Option.Option<unknown>; readonly after: ReadonlyArray<string> }> }
    const { probe }: Probe = await import(new URL("./probe.ts", folder).href)
    const report: TaskReport = { task: TaskId.make("t1"), parent: SessionId.make("chat"), session: SessionId.make("task"), outcome: "Finished", text: "It is 42." }
    expect(await Effect.runPromise(probe(report))).toEqual({
      first: Option.some({ _tag: "Message", text: "a" }),
      // The message sent behind the report is drained; the report stays, for a turn of its own.
      drained: ["b"],
      next: Option.some({ _tag: "Report", report }),
      after: [],
    })
  })

  test("a task starts at once, its helper sees only the task and works it out with a tool, and its report is answered in a turn of its own after", async () => {
    const folder = write("report", DEFAULT_AGENT, DEFAULT_HELPER, true)
    const result = await Effect.runPromise(runMain(folder, "What is 6 * 7? Work it out in the background.", [
      calling("startTask", { task: "Work out 6 * 7." }),
      says("Started t1: I will tell you."),
      // The helper's calls, made once the first turn has answered: the hold is let go then. It calls the calculator,
      // which tools.ts's handlers answer, then answers from its result.
      calling("calculator", { a: 6, op: "*", b: 7 }),
      says("6 * 7 is 42."),
      says("The task says: 42."),
    ], 2))
    expect(result.shown).toEqual(["Started t1: I will tell you.", "The task says: 42."])
    // The helper was sent its system text and the task, nothing of the conversation; then its call and its result, in
    // its own session.
    expect(result.calls[2]).toEqual([{ role: "system", text: HELPER_SYSTEM }, { role: "user", text: "Work out 6 * 7." }])
    expect(result.calls[3]).toEqual([
      { role: "system", text: HELPER_SYSTEM },
      { role: "user", text: "Work out 6 * 7." },
      { role: "assistant", text: 'calculator({"a":6,"op":"*","b":7})' },
      { role: "tool", text: "→ 42" },
    ])
    // The report's turn: the conversation so far, then the report, in the kernel's words, as a user message.
    const started = result.calls[1]?.at(-1)?.text ?? ""
    const session = /"session":"([^"]+)"/.exec(started)?.[1] ?? ""
    // The report's words name the task and hold its answer: the parent is not among them.
    const report = reportText({ task: TaskId.make("t1"), parent: SessionId.make("any"), session: SessionId.make(session), outcome: "Finished", text: "6 * 7 is 42." })
    expect(result.calls[4]).toEqual([
      { role: "system", text: SYSTEM },
      { role: "user", text: "What is 6 * 7? Work it out in the background." },
      { role: "assistant", text: 'startTask({"task":"Work out 6 * 7."})' },
      { role: "tool", text: started },
      { role: "assistant", text: "Started t1: I will tell you." },
      { role: "user", text: report },
    ])
  })

  test("with one-at-a-time (an experiment), a second task is refused in the kernel's words while the first runs", async () => {
    const folder = write("one-at-a-time", Option.getOrThrow(oneAtATime(DEFAULT_AGENT)), DEFAULT_HELPER, true)
    const result = await Effect.runPromise(runMain(folder, "Start two tasks.", [
      calling("startTask", { task: "one" }),
      calling("startTask", { task: "two" }),
      says("One started, one refused."),
      says("one done."),
      says("Task one is done."),
    ], 2))
    expect(result.calls[2]?.at(-1)).toEqual({ role: "tool", text: `→ failed: ${JSON.stringify("1 task is running, the most at once. Wait for one to report, or cancel one with cancelTask, then start this one.")}` })
    expect(result.shown).toEqual(["One started, one refused.", "Task one is done."])
  })

  test("type-checks as TypeScript, every file, as shown and as each experiment leaves them", () => {
    write("typed/shown")
    write("typed/instant", DEFAULT_AGENT, Option.getOrThrow(instant(DEFAULT_HELPER)))
    write("typed/one-at-a-time", Option.getOrThrow(oneAtATime(DEFAULT_AGENT)))
    write("typed/held", DEFAULT_AGENT, DEFAULT_HELPER, true)
    const checked = compile("typed")
    expect(checked.said).toBe("")
    expect(checked.code).toBe(0)
  }, 120_000)

  test("type-level: a program that leaves out the tasks plugin does not compile, and the compiler names Tasks", () => {
    write("missing-tasks/x", DEFAULT_AGENT.replace(TASKS_LINE, "  // No tasks plugin is given here.\n"))
    const checked = compile("missing-tasks")
    expect(checked.code).not.toBe(0)
    expect(checked.said).toContain("agent.ts")
    expect(checked.said).toContain("Type 'Tasks' is not assignable to type 'never'")
    expect(checked.said.split("\n").filter((line) => line.includes("error TS"))).toHaveLength(1)
  }, 120_000)

  test("type-level: a program that gives the tasks plugin nowhere to put a report does not compile, and the compiler names TaskReports", () => {
    write("missing-reports/x", DEFAULT_AGENT.replace("  Effect.provide(reportsOn(pane)), // where a task's report goes: the chat's queue\n", "  // No place for reports is given here.\n"))
    const checked = compile("missing-reports")
    expect(checked.code).not.toBe(0)
    expect(checked.said).toContain("agent.ts")
    expect(checked.said).toContain("Type 'TaskReports' is not assignable to type 'never'")
    expect(checked.said.split("\n").filter((line) => line.includes("error TS"))).toHaveLength(1)
  }, 120_000)
})
