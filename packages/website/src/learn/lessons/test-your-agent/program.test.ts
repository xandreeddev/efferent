// Lesson 12's five files, compiled as written, type-checked, and run on the
// kernel: agent.ts is the base program with `program` exported and nothing
// else changed; checks.ts runs that program over a stack of its own and
// each of its checks passes; a calculator that subtracts, a script that makes
// no call and a model that misses runs fail the checks they should, in the
// exact words; and a stack that leaves out the tools' handlers or the model
// does not compile. chat.ts as the page runs it, with its types taken out, is
// checked against the text the page shows.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Queue, Ref, Result, Stream } from "effect"
import type { LanguageModel } from "effect/ai"
import { kernel, Sessions } from "@xandreed/core/kernel"
import { inProcessJournal, scriptedModel, sessions } from "@xandreed/sdk/kernel"
import type { ModelScript } from "@xandreed/sdk/kernel"
import { programOf, runStatements } from "../../evaluate.ts"
import { formatRegion } from "../../format.ts"
import { applyExperiment } from "../../lesson.ts"
import { Chat as PageChat } from "../../page-chat.ts"
import { BASE_AGENT, IMPORTS as BASE_IMPORTS } from "../base/agent.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, EXPORTED, IMPORTS, moduleOf, REPLACED, RUN_IT } from "./agent.source.ts"
import { CHAT, chatBodyOf, TYPES } from "./chat.source.ts"
import { CHECKS_IMPORTS, checksDocumentOf, checksModuleOf, DEFAULT_CHECKS, LIST_END, LIST_INTRO, TYPED } from "./checks.source.ts"
import { BROKEN_SUM, breakCalculator, LIVE, LIVE_CHECK, VACUOUS, vacuous, withLive } from "./config-edit.ts"
import { testYourAgent } from "./lesson.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

/** The four files a learner edits, as the lesson starts or as an experiment leaves them. */
interface Files {
  readonly agent?: string
  readonly checks?: string
  readonly memory?: string
  readonly tools?: string
}

const write = (name: string, files: Files = {}) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(files.agent ?? DEFAULT_AGENT))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./checks.ts", at), checksModuleOf(files.checks ?? DEFAULT_CHECKS))
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(files.memory ?? DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(files.tools ?? DEFAULT_TOOLS))
  return at
}

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const STARTERS: Record<string, string> = Object.fromEntries(testYourAgent.files.map((file) => [file.id, file.defaultText]))

/** The files as an experiment leaves them: every file it edits, all of them or none. */
const applied = (id: string): Files => {
  const experiment = Option.fromNullishOr(testYourAgent.experiments[id])
  return Object.fromEntries(Option.getOrThrow(Option.flatMap(experiment, (one) => applyExperiment(one, (file) => STARTERS[file] ?? ""))))
}

/** The lines of `after` that `before` has not, and the lines of `before` that `after` has not. */
const changed = (before: string, after: string) => ({
  gone: before.split("\n").filter((line) => !after.split("\n").includes(line)),
  come: after.split("\n").filter((line) => !before.split("\n").includes(line)),
})

/** How many times `piece` is in `text`. */
const times = (text: string, piece: string): number => text.split(piece).length - 1

type Check = { readonly id: string; readonly name: string; readonly run: Effect.Effect<unknown, unknown> }
type ChecksWith = (model: Layer.Layer<LanguageModel.LanguageModel>) => ReadonlyArray<Check>

const calls = (...made: ReadonlyArray<{ readonly name: string; readonly params: Record<string, string | number> }>): ModelScript[number] => ({ _tag: "Calls", pieces: [], calls: made })
const says = (text: string): ModelScript[number] => ({ _tag: "Answers", pieces: [text] })
const FIVE = { name: "calculator", params: { a: 2, op: "+", b: 3 } }

/**
 * Run the checks of the checks.ts written at `at`, one after the other. `script` is the model the module is given
 * as the model picked: only a live check runs on it. What comes back, for each check: its id, `"passed"` and
 * what it said, or `"failed"` and what it found.
 */
const ran = async (at: URL, script: ModelScript = [says("no check asked for the model picked")]) => {
  const { checksWith }: { readonly checksWith: ChecksWith } = await import(new URL("./checks.ts", at).href)
  const picked = await Effect.runPromise(scriptedModel(script))
  const results: Array<ReadonlyArray<unknown>> = []
  /** What each failed check failed with: the kernel's `ConformanceFailure`, by its tag and the check it names. */
  const failures: Array<ReadonlyArray<unknown>> = []
  for (const check of checksWith(picked.model)) {
    const exit = await Effect.runPromise(Effect.exit(Effect.timeout(check.run, "10 seconds")))
    if (Exit.isFailure(exit)) Option.match(Cause.findErrorOption(exit.cause), { onNone: () => {}, onSome: (error) => { failures.push([Predicate.hasProperty(error, "_tag") ? error._tag : "", Predicate.hasProperty(error, "check") ? error.check : ""]) } })
    results.push(Exit.isSuccess(exit)
      ? [check.id, "passed", exit.value]
      : [check.id, "failed", Option.match(Cause.findErrorOption(exit.cause), { onNone: () => Cause.prettyErrors(exit.cause)[0]?.message, onSome: (error) => (error instanceof Error ? error.message : String(error)) })])
  }
  return { results, failures, sent: await Effect.runPromise(picked.calls), names: checksWith(picked.model).map((check) => [check.id, check.name]) }
}

const NAMES = [
  ["sum", "a sum is worked out by the calculator, and the turn answers"],
  ["wrong-call", "a call the model got wrong is a failed result, and the turn still answers"],
  ["two-turns", "two messages are two turns, each completed with its answer"],
]
const PASSED = [["sum", "passed", undefined], ["wrong-call", "passed", undefined], ["two-turns", "passed", undefined]]

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/** Run `main` from the agent.ts written at `at` with a scripted model: one message, and what was shown for it with every prompt the model received. */
const runMain = (at: URL, message: string, script: ModelScript) => Effect.gen(function* () {
  const { run }: { readonly run: Run } = yield* Effect.promise(() => import(new URL("./agent.ts", at).href))
  const { model, calls: sent } = yield* scriptedModel(script)
  const shown = yield* Ref.make<ReadonlyArray<string>>([])
  const done = yield* Deferred.make<void>()
  const send = yield* Deferred.make<(text: string) => void>()
  const note = (text: string) => Effect.runSync(Ref.update(shown, (all) => [...all, text]))
  const pane: Pane = {
    onSend: (given) => { Effect.runSync(Deferred.succeed(send, given)) },
    appendToAnswer: () => {},
    finishAnswer: (text) => { note(`reply: ${text}`); Effect.runSync(Deferred.succeed(done, undefined)) },
    showError: (error) => { note(`error: ${String(error)}`); Effect.runSync(Deferred.succeed(done, undefined)) },
    showStatus: (text) => note(`status: ${text}`),
  }
  const program = yield* Effect.forkChild(run(pane, model))
  const given = yield* Deferred.await(send)
  given(message)
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), calls: yield* sent }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

describe("lesson 12's displayed program", () => {
  test("agent.ts is the base program with `program` exported: its comment and its declaration change, and nothing else", () => {
    for (const [from] of REPLACED) expect({ from, held: times(BASE_AGENT, from) }).toEqual({ from, held: 1 })
    expect(changed(BASE_AGENT, DEFAULT_AGENT)).toEqual({
      gone: ["// The program: it runs as long as the page is open.", "const program = Effect.scoped("],
      come: [
        "// The program: it runs as long as the page is open. It is exported, so checks.ts runs the same",
        "// program that main runs.",
        "export const program = Effect.scoped(",
      ],
    })
    expect(DEFAULT_AGENT).toContain(EXPORTED)
    expect(DEFAULT_AGENT.split("\n")).toHaveLength(BASE_AGENT.split("\n").length + 1)
    // Nothing in the loop changes: one turn, from its comment to the program's, is the base's text.
    const loopOf = (agent: string) => agent.slice(agent.indexOf("// One turn: a loop."), agent.indexOf("// The program: it runs as long as the page is open."))
    expect(loopOf(BASE_AGENT).length).toBeGreaterThan(1500)
    expect(loopOf(DEFAULT_AGENT)).toBe(loopOf(BASE_AGENT))
    // Nor does main: from its comment to the end, the base's text. The comment is where the typed module is cut.
    expect(times(DEFAULT_AGENT, RUN_IT)).toBe(1)
    expect(DEFAULT_AGENT.slice(DEFAULT_AGENT.indexOf(RUN_IT))).toBe(BASE_AGENT.slice(BASE_AGENT.indexOf(RUN_IT)))
    // The imports are the base's.
    expect(IMPORTS).toBe(BASE_IMPORTS)
    expect(documentOf(DEFAULT_AGENT).startsWith(`${IMPORTS}\n\n// The system text`)).toBe(true)
    // The files the page shows are these texts; tools.ts and memory.ts are lesson 2's, and chat.ts lesson 1's.
    expect([STARTERS.checks, STARTERS.agent, STARTERS.tools, STARTERS.memory]).toEqual([DEFAULT_CHECKS, DEFAULT_AGENT, DEFAULT_TOOLS, DEFAULT_MEMORY])
    expect(testYourAgent.files.find((file) => file.id === "chat")?.documentOf("")).toBe(CHAT)
  })

  test("main still runs the program: a sum goes to the calculator and is answered, with the prompts the base sends", async () => {
    const result = await Effect.runPromise(runMain(write("main"), "What is 2 + 3?", [calls(FIVE), says("It is 5.")]))
    expect(result.shown).toEqual(["status: turn 1", "status: step 1: calculator", "reply: It is 5."])
    const SYSTEM = { role: "system", text: "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence." }
    expect(result.calls).toEqual([
      [SYSTEM, { role: "user", text: "What is 2 + 3?" }],
      [SYSTEM, { role: "user", text: "What is 2 + 3?" }, { role: "assistant", text: `calculator(${JSON.stringify(FIVE.params)})` }, { role: "tool", text: "→ 5" }],
    ])
  })

  test("chat.ts as the page runs it is the shown text with its imports and its types taken out, and nothing else: each piece is in lesson 1's text once", () => {
    for (const [from] of TYPES) expect({ from, held: times(CHAT, from) }).toEqual({ from, held: 1 })
    const body = chatBodyOf(CHAT)
    expect(changed(CHAT, body)).toEqual({
      gone: [
        'import { Context, Effect, Layer, Queue, Stream } from "effect"',
        'import { Sessions } from "@xandreed/core/kernel"',
        'import type { SessionId } from "@xandreed/core/kernel"',
        "export class Chat extends Context.Service<Chat, {",
        '  // The conversation this chat shows. "Clear context" gives it a new one.',
        "  readonly session: SessionId",
        "  // Every message you send, in order. It waits while you send nothing, and never ends.",
        "  readonly messages: Stream.Stream<string>",
        "  // Every message waiting now, taken at once. A turn takes the ones sent while the turn before it ran.",
        "  readonly drain: Effect.Effect<ReadonlyArray<string>>",
        "  // Draw a piece of the answer as it arrives.",
        "  readonly stream: (piece: string) => Effect.Effect<void>",
        "  // Show the whole answer: the turn is done.",
        "  readonly reply: (text: string) => Effect.Effect<void>",
        "  // Show why a turn failed.",
        "  readonly fail: (error: unknown) => Effect.Effect<void>",
        "  // Set the line above the chat that says what the agent is doing.",
        "  readonly status: (text: string) => Effect.Effect<void>",
        '}>()("lesson/Chat") {}',
        "// What a chat pane offers. This page has one; a terminal or a test would have another.",
        "export interface ChatPane {",
        "  readonly onSend: (send: (text: string) => void) => void",
        "  readonly appendToAnswer: (piece: string) => void",
        "  readonly finishAnswer: (text: string) => void",
        "  readonly showError: (error: unknown) => void",
        "  readonly showStatus: (text: string) => void",
        "}",
        "export const chatOn = (pane: ChatPane) =>",
        "      const waiting = yield* Queue.bounded<string>(100)",
      ],
      come: ['class Chat extends Context.Service()("lesson/Chat") {}', "const chatOn = (pane) =>", "      const waiting = yield* Queue.bounded(100)"],
    })
    // What is left names no type: no annotation, no interface, no type argument, no import.
    expect(body).not.toMatch(/\bimport\b|\binterface\b|\breadonly\b|: string|: unknown|<string>|<Chat\b|ChatPane|SessionId/)
    // From the chat's own comment down, the layer is lesson 1's text but for the two lines above.
    const layerOf = (text: string) => text.slice(text.indexOf("// The chat over a pane"))
    expect(changed(layerOf(CHAT), layerOf(body))).toEqual({
      gone: ["export const chatOn = (pane: ChatPane) =>", "      const waiting = yield* Queue.bounded<string>(100)"],
      come: ["const chatOn = (pane) =>", "      const waiting = yield* Queue.bounded(100)"],
    })
  })

  test("chat.ts as the page runs it is a chat over the pane it is given: a message sent on the pane reaches the program, and what the program says reaches the pane; its Chat is found under the page's key", async () => {
    const shown: Array<string> = []
    let send: (text: string) => void = () => {}
    const pane: Pane = {
      onSend: (given) => { send = given },
      appendToAnswer: (piece) => { shown.push(`piece: ${piece}`) },
      finishAnswer: (text) => { shown.push(`reply: ${text}`) },
      showError: (error) => { shown.push(`error: ${String(error)}`) },
      showStatus: (text) => { shown.push(`status: ${text}`) },
    }
    // The text is run as the page runs it, untyped, with the names its imports list, and a program after it that
    // asks for the page's `Chat`, as the page's copy of agent.ts would: it is given the chat this text made.
    const probe = `${chatBodyOf(CHAT)}
const probe = Effect.gen(function* () {
  const chat = yield* PageChat
  sendAll(["first", "second", "third"])
  const first = yield* Stream.runHead(chat.messages)
  const rest = yield* chat.drain
  yield* chat.stream("a piece")
  yield* chat.status("working")
  yield* chat.reply("done")
  yield* chat.fail("broken")
  const held = yield* (yield* Sessions).read(chat.session)
  return { first: first.value, rest, owner: held.header.owner, key: Chat.key, same: Chat === PageChat }
}).pipe(Effect.provide(chatOn(pane)), Effect.provide(sessions()), Effect.provide(inProcessJournal()), Effect.provide(kernel()))`
    const names = { Context, Effect, Layer, Queue, Stream, Sessions, PageChat, pane, sendAll: (texts: ReadonlyArray<string>) => texts.forEach((one) => send(one)), sessions, inProcessJournal, kernel }
    const program = Result.getOrThrow(Result.flatMap(runStatements("chat.ts did not run: ", probe, "probe", names), programOf))
    expect(await Effect.runPromise(program)).toEqual({ first: "first", rest: ["second", "third"], owner: "learner", key: "lesson/Chat", same: false })
    expect(PageChat.key).toBe("lesson/Chat")
    expect(shown).toEqual(["piece: a piece", "status: working", "reply: done", "error: broken"])
  })

  test("checks.ts: its imports, the list its experiments add to, and the lines that take a type in the module a test compiles", () => {
    expect(CHECKS_IMPORTS.split("\n")).toEqual([
      'import { Effect, Fiber, Option, Queue } from "effect"',
      'import { ConformanceFailure, kernel, Sessions } from "@xandreed/core/kernel"',
      'import { inProcessJournal, scriptedModel, sessions, turnsOf } from "@xandreed/sdk/kernel"',
      'import { program } from "./agent.ts"',
      'import { Chat, chatOn } from "./chat.ts"',
      'import { flatMemory } from "./memory.ts"',
      'import { toolsLive } from "./tools.ts"',
    ])
    expect(checksDocumentOf(DEFAULT_CHECKS)).toBe(`${CHECKS_IMPORTS}\n\n${DEFAULT_CHECKS}\n`)
    expect(times(DEFAULT_CHECKS, LIST_INTRO)).toBe(1)
    expect(DEFAULT_CHECKS.endsWith(LIST_END)).toBe(true)
    // Every typed line is in the starter text once, but the last: the function the `live` experiment adds.
    expect(TYPED.map(([from]) => times(DEFAULT_CHECKS, from))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0])
    expect(TYPED.slice(-1).map(([from]) => times(LIVE, from))).toEqual([1])
    // The stack a check runs on is the base's main, layer for layer, with the model given where main has the page's.
    const layers = (text: string) => text.split("\n").flatMap((line) => /^\s*Effect\.provide\((.+?)\),? \/\//.exec(line)?.[1] ?? [])
    expect(layers(DEFAULT_AGENT)).toEqual(["toolsLive", "flatMemory", "chatOn(pane)", "sessions()", "inProcessJournal()", "kernel()", "model"])
    expect(layers(DEFAULT_CHECKS)).toEqual(layers(DEFAULT_AGENT))
    // No cast, and no type written out, in the text a learner reads.
    expect(DEFAULT_CHECKS).not.toMatch(/\bas (?:never|any|unknown|const)\b|: (?:string|number|unknown)\b/)
  })

  test("each experiment changes the pieces it names, and no other; one applied twice, or over a text that lost its piece, changes nothing", async () => {
    expect(changed(DEFAULT_TOOLS, Option.getOrThrow(breakCalculator(DEFAULT_TOOLS)))).toEqual({
      gone: ['      : Effect.succeed({ "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op]),'],
      come: ['      : Effect.succeed({ "+": a - b, "-": a - b, "*": a * b, "/": a / b }[op]),'],
    })
    expect(Option.getOrThrow(breakCalculator(DEFAULT_TOOLS))).toContain(BROKEN_SUM)
    const withVacuous = Option.getOrThrow(vacuous(DEFAULT_CHECKS))
    expect(withVacuous).toBe(`${DEFAULT_CHECKS.slice(0, -1)}${VACUOUS}]`)
    const live = Option.getOrThrow(withLive(DEFAULT_CHECKS))
    expect(live).toBe(`${DEFAULT_CHECKS.slice(0, -1)}${LIVE_CHECK}]`.replace(LIST_INTRO, `${LIVE}${LIST_INTRO}`))
    expect(live.split(LIVE)).toHaveLength(2)
    // The two experiments on checks.ts go together, in either order: each adds to the end of the list.
    const both = Option.getOrThrow(withLive(withVacuous))
    expect(both.endsWith(`${VACUOUS}${LIVE_CHECK}]`)).toBe(true)
    expect(Option.getOrThrow(vacuous(live)).endsWith(`${LIVE_CHECK}${VACUOUS}]`)).toBe(true)
    // Applied twice, an experiment finds its piece already there, and changes nothing.
    expect([breakCalculator(Option.getOrThrow(breakCalculator(DEFAULT_TOOLS))), vacuous(withVacuous), withLive(live)]).toEqual([Option.none(), Option.none(), Option.none()])
    // A list the learner rewrote is left alone.
    expect([vacuous("const checks = []"), withLive("const checks = []"), breakCalculator("const tools = 1")]).toEqual([Option.none(), Option.none(), Option.none()])
    // Every text an experiment leaves is as Format leaves it, and no line of a comment is longer than 100 columns.
    for (const text of [withVacuous, live, both, Option.getOrThrow(breakCalculator(DEFAULT_TOOLS))]) {
      expect(await formatRegion(text, "")).toEqual({ ok: true, text })
      expect(text.split("\n").filter((line) => line.trimStart().startsWith("//") && line.length > 100)).toEqual([])
    }
  })

  test("checks.ts on the kernel: each check runs the program on its script, over a stack of its own, and passes", async () => {
    const { results, sent, names } = await ran(write("checks"))
    expect(names).toEqual(NAMES)
    expect(results).toEqual(PASSED)
    // The model picked was sent nothing: every check ran on its own script.
    expect(sent).toEqual([])
  })

  test("a calculator that subtracts (an experiment) fails the sum's check, which names the record and what it held; the other two pass", async () => {
    const { results, failures } = await ran(write("break-calculator", applied("break-calculator")))
    expect(results).toEqual([["sum", "failed", "record #4: the calculator answered -1, not 5"], ["wrong-call", "passed", undefined], ["two-turns", "passed", undefined]])
    // What the check failed with is the kernel's failure of a check: its tag, and the id of the check.
    expect(failures).toEqual([["ConformanceFailure", "sum"]])
  })

  test("a check that asks something of every call passes over a script that makes none (an experiment); the form that counts first fails on the same script", async () => {
    const { results, names } = await ran(write("vacuous", applied("vacuous")))
    expect(names.slice(3)).toEqual([["every-call", "every call's result is 5"], ["one-call", "one call was made, and its result is 5"]])
    expect(results).toEqual([...PASSED, ["every-call", "passed", undefined], ["one-call", "failed", "0 calls were made, not 1"]])
    // The same check is no longer vacuous over a script that makes a call: with the broken calculator it fails.
    const broken = await ran(write("vacuous-broken", { ...applied("vacuous"), ...applied("break-calculator"), checks: (applied("vacuous").checks ?? "").replace('"every call\'s result is 5",\n    [{ _tag: "Answers", pieces: ["It is 5."] }],', `"every call's result is 5",\n    [{ _tag: "Calls", pieces: [], calls: [{ name: "calculator", params: { a: 2, op: "+", b: 3 } }] }, { _tag: "Answers", pieces: ["It is 5."] }],`) }))
    expect(broken.results[3]).toEqual(["every-call", "failed", "calculator did not answer 5"])
  })

  test("a live check (an experiment) runs the program on the model picked five times and says how many runs passed: all of them passes, fewer fails with the rate", async () => {
    const at = write("live", applied("live"))
    // A scripted model repeats its last entry past the end of its script, so five runs of two calls are written out.
    const all = await ran(at, Array.from({ length: 5 }).flatMap(() => [calls(FIVE), says("Five.")]))
    expect(all.names[3]).toEqual(["live-sum", "the model you picked works out 2 + 3 with the calculator"])
    expect(all.results).toEqual([...PASSED, ["live-sum", "passed", "5 of 5 runs passed"]])
    // Five runs, two model calls each: the model picked was sent ten prompts, and the scripted checks none of them.
    expect(all.sent).toHaveLength(10)
    expect(all.sent.map((prompt) => prompt[1])).toEqual(Array.from({ length: 10 }, () => ({ role: "user", text: "What is 2 + 3?" })))
    // A model that calls the calculator in three runs and answers by itself in two: a rate, and the check fails.
    const some = await ran(at, [calls(FIVE), says("Five."), calls(FIVE), says("Five."), calls(FIVE), says("Five."), says("It is 5, I think.")])
    expect(some.results[3]).toEqual(["live-sum", "failed", "3 of 5 runs passed. The first that did not: 0 calls were made, not 1"])
    expect(some.sent).toHaveLength(8)
    // A model that fails is a run that did not pass, not a check that stops.
    const none = await ran(at, [{ _tag: "Fails" }])
    expect(none.results[3]).toEqual(["live-sum", "failed", "0 of 5 runs passed. The first that did not: 0 calls were made, not 1"])
  })

  test("what a check says when it fails names what it read: a turn the model failed in by the record that closed it, a call that was answered by the record of its result, a count by its number", async () => {
    const failing = DEFAULT_CHECKS
      // The second turn's model call fails: the turn closes as failed, with no answer.
      .replace('[{ _tag: "Answers", pieces: ["Hello."] }],', '[{ _tag: "Answers", pieces: ["Hello."] }, { _tag: "Fails" }],')
      // The call the model "got wrong" is a right one: its result is no failure.
      .replace('params: { a: "two", op: "+", b: 3 }', "params: { a: 2, op: \"+\", b: 3 }")
      // The sum's script answers with other words.
      .replace('{ _tag: "Answers", pieces: ["It is 5."] },\n    ],\n    ["What is 2 + 3?"],', '{ _tag: "Answers", pieces: ["Five."] },\n    ],\n    ["What is 2 + 3?"],')
    expect(changed(DEFAULT_CHECKS, failing).gone).toHaveLength(3)
    const { results } = await ran(write("failing", { checks: failing }))
    expect(results).toEqual([
      ["sum", "failed", 'turn 1 answered "Five.", not "It is 5."'],
      ["wrong-call", "failed", "record #4: the call was answered, not failed"],
      ["two-turns", "failed", "record #7: turn 2 closed as Failed"],
    ])
    // One message where the check expects two answers: the count is said before any turn is read.
    const short = await ran(write("short", { checks: DEFAULT_CHECKS.replace('["Hi.", "Still there?"],', '["Hi."],') }))
    expect(short.results[2]).toEqual(["two-turns", "failed", "1 turns were stored, not 2"])
  })

  test("type-level: a check's stack that leaves out the tools' handlers does not compile, nor one that leaves out the model, and the compiler names each", () => {
    // `turnsAfter` says its stack needs nothing more. Take the tools' line away, and the program still asks for the
    // calculator's handler; take the model's away, and it still asks for a model. tsc refuses each where the stack is.
    const TOOLS_LINE = "      Effect.provide(toolsLive), // what each tool does when it is called\n"
    const MODEL_LINE = "      Effect.provide(model), // a model that follows a script, or the model you picked\n"
    for (const line of [TOOLS_LINE, MODEL_LINE]) expect({ line, held: times(DEFAULT_CHECKS, line) }).toEqual({ line, held: 1 })
    write("missing/handlers", { checks: DEFAULT_CHECKS.replace(TOOLS_LINE, "") })
    write("missing/model", { checks: DEFAULT_CHECKS.replace(MODEL_LINE, "") })
    const missing = new URL("./missing/tsconfig.json", dir)
    writeFileSync(missing, JSON.stringify({ extends: "../../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(missing)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    const said = `${checked.stdout.toString()}${checked.stderr.toString()}`
    rmSync(new URL("./missing/", dir), { recursive: true, force: true })
    expect(checked.exitCode).not.toBe(0)
    const errors = said.split("\n").filter((line) => line.includes("error TS"))
    // One error a program, each in checks.ts, on the function whose stack is short.
    expect(errors.map((line) => line.slice(0, line.indexOf("(")))).toEqual(["src/learn/lessons/test-your-agent/generated-program-check/missing/handlers/checks.ts", "src/learn/lessons/test-your-agent/generated-program-check/missing/model/checks.ts"])
    for (const error of errors) expect(error).toContain("is not assignable to type 'Effect<readonly TurnRead[], unknown, never>'")
    // Which of the toolkit's handlers tsc names is the compiler's own order, which moves as the kernel's exports do;
    // the lesson says "a handler of one of the tools", never which.
    expect(said).toMatch(/Type 'Handler<"(calculator|remember|recall)">' is not assignable to type 'never'/)
    expect(said).toContain("Type 'LanguageModel' is not assignable to type 'never'")
  }, 120_000)

  test("type-checks as TypeScript, all five files, as shown and as each experiment leaves them", () => {
    write("typed")
    write("typed-break-calculator", applied("break-calculator"))
    write("typed-vacuous", applied("vacuous"))
    write("typed-live", applied("live"))
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
