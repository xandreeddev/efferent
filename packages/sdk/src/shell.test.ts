import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { dataOf, kernel, messageOf, Sessions, toolResult, userMessage } from "@xandreed/core"
import type { OpenSession, SessionId, StoredEvent } from "@xandreed/core"
import {
  Approval, approveIn, callTool, decidedEvent, flatMemory, inProcessJournal, Memory, modelAnswer, scriptedModel, scriptedShell, sessions, Shell, shellHandlers,
  ShellRefused, shellTools,
} from "./index.js"
import type { Decision, ModelScript, ModelToolCall, Ran, ScriptedRun } from "./index.js"

/*
 * A shell (ADR 0028), as a test: a model runs commands through `runCommand`,
 * over the `Shell` the host provides; here a scripted one, so nothing is
 * spawned. The tool never asks: whether a command runs is the app's, which
 * wraps the `Shell` with a rule or asks in its loop before the call.
 * `docs/kernel.md` quotes the stack and the app's two layers.
 */

const SYSTEM = "Use a tool when it helps."

/** What the turn does with a call before it runs it: here, nothing. An app that asks a person puts its question here. */
type BeforeCall<R = never> = (session: OpenSession, call: ModelToolCall) => Effect.Effect<boolean, never, R>

const always: BeforeCall = () => Effect.succeed(true)

/** A host's turn with the shell's tool, one message a turn, run before each call through `before`. */
const turnOf = <R>(before: BeforeCall<R>) => (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
  const memory = yield* Memory
  const language = yield* LanguageModel.LanguageModel
  const toolkit = yield* shellTools
  const session = yield* (yield* Sessions).open(conversation)
  yield* session.append(userMessage(message))
  for (let step = 1; step <= 6; step++) {
    const prompt = Prompt.make([{ role: "system", content: SYSTEM }, ...(yield* memory.context(session))])
    const answer = yield* modelAnswer(language.streamText({ prompt, toolkit: shellTools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
    if (answer.toolCalls.length === 0) return answer.text
    for (const call of answer.toolCalls) if (yield* before(session, call)) yield* callTool(toolkit, call, session)
  }
  return "stopped"
}))

const nobody = Layer.succeed(Approval, Approval.of({ ask: () => Effect.succeed<Decision>({ _tag: "Refused" }) }))

// #region stack
// What a program with the shell's tool provides: the model, the tool's handler, a memory, the sessions over a store,
// and the shell. On Node or Bun the shell is `processShell({ cwd, env })` from `@xandreed/sdk/node`; a test
// gives a scripted one, which runs nothing.
const stackOf = (model: Layer.Layer<LanguageModel.LanguageModel>, shell: Layer.Layer<Shell>) =>
  Layer.mergeAll(model, shellHandlers, flatMemory, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))).pipe(Layer.provideMerge(shell))
// #endregion stack

const exited = (stdout: string): Ran => ({ stdout, stderr: "", stdoutCut: 0, stderrCut: 0, ended: { _tag: "Exited", code: 0 } })
const calling = (command: string) => ({ _tag: "Calls" as const, pieces: [], calls: [{ name: "runCommand", params: { command } }] })
const answering = (text: string) => ({ _tag: "Answers" as const, pieces: [text] })
const results = (journal: ReadonlyArray<StoredEvent>) =>
  journal.flatMap((record) => Option.toArray(messageOf(record))).flatMap((message) => (message._tag === "ToolResult" ? [[message.result, message.isFailure]] : []))

/** Turns of one conversation over a scripted shell, wrapped by `wrap`: the journal after, and the commands the shell was asked. */
const conversation = (script: ModelScript, runs: ReadonlyArray<ScriptedRun>, messages: ReadonlyArray<string>, options: {
  readonly wrap?: (shell: Layer.Layer<Shell>) => Layer.Layer<Shell>
  readonly before?: BeforeCall<Approval>
  readonly approval?: Layer.Layer<Approval>
} = {}) => Effect.gen(function* () {
  const { model } = yield* scriptedModel(script)
  const { shell, runs: asked } = yield* scriptedShell(runs)
  const turn = turnOf<Approval>(options.before ?? always)
  const journal = yield* Effect.gen(function* () {
    const all = yield* Sessions
    const id = yield* all.create({ owner: "test" })
    for (const message of messages) yield* turn(id, message)
    return (yield* all.read(id)).events
  }).pipe(Effect.provide(Layer.merge(stackOf(model, (options.wrap ?? ((inner) => inner))(shell)), options.approval ?? nobody)))
  return { journal, asked: (yield* asked).map((request) => request.command) }
})

describe("a shell", () => {
  test("a model runs a command and reads how it ended; the journal holds the call and its result", async () => {
    const { journal, asked } = await Effect.runPromise(conversation([calling("ls"), answering("There is one file.")], [exited("a.txt\n")], ["What is here?"]))
    expect(results(journal)).toEqual([[{ ended: "exited", exitCode: 0, stdout: "a.txt\n", stderr: "", stdoutCut: 0, stderrCut: 0 }, false]])
    expect(asked).toEqual(["ls"])
  })
})

describe("permission is the app's: two layers it wraps around the tool", () => {
  test("a shell that declines by a rule: the model reads why, and the command is not run", async () => {
    // #region shell-declining
    // A `Shell` of the app's over the one it was given: a command that names `rm` is declined, every other passes.
    const keepFiles = <E, R>(shell: Layer.Layer<Shell, E, R>) => Layer.effect(Shell, Effect.gen(function* () {
      const inner = yield* Shell
      return Shell.of({
        run: (request) => /(^|[\s;&|])rm\s/.test(request.command)
          ? Effect.fail(new ShellRefused({ reason: "this agent may not remove files", message: `declined ${request.command}` }))
          : inner.run(request),
      })
    })).pipe(Layer.provide(shell))
    // #endregion shell-declining
    const { journal, asked } = await Effect.runPromise(conversation(
      [calling("rm -rf build"), calling("ls build"), answering("Not removed.")],
      [exited("out.js\n")],
      ["Clean the build."],
      { wrap: keepFiles },
    ))
    expect(results(journal)).toEqual([
      ["The shell declined this command: \"this agent may not remove files\". Do not run it again unless the user asks for it.", true],
      [{ ended: "exited", exitCode: 0, stdout: "out.js\n", stderr: "", stdoutCut: 0, stderrCut: 0 }, false],
    ])
    expect(asked).toEqual(["ls build"])
  })

  test("asking a person: the app's loop asks before each command, the answer is a record, and a no is the call's result", async () => {
    const asked = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
    const answers: ReadonlyArray<Decision> = [{ _tag: "Refused" }, { _tag: "Approved" }]
    const person = Layer.succeed(Approval, Approval.of({
      ask: (request) => Effect.map(Ref.updateAndGet(asked, (all) => [...all, request.detail]), (all): Decision => answers[all.length - 1] ?? { _tag: "Refused" }),
    }))
    // #region shell-asking
    // The app's turn asks before it runs a command: the tool never asks, and a `Shell` cannot, since an answer is
    // stored in a turn. One key for every command, so "always" stands for the shell; an app keys by command if it likes.
    const askFirst: BeforeCall<Approval> = (session, call) => call.name !== "runCommand"
      ? Effect.succeed(true)
      : approveIn(session, { action: "shell.run", detail: `Let the agent run: ${JSON.stringify(call.params)}` }).pipe(Effect.matchEffect({
        onFailure: (refusal) => Effect.as(Effect.orDie(session.append(toolResult(call, refusal, true))), false),
        onSuccess: () => Effect.succeed(true),
      }))
    // #endregion shell-asking
    const { journal, asked: ran } = await Effect.runPromise(conversation(
      [calling("git push"), answering("Not pushed."), calling("git status"), answering("Clean.")],
      [exited("nothing to commit\n")],
      ["Push.", "Status?"],
      { before: askFirst, approval: person },
    ))
    expect(await Effect.runPromise(Ref.get(asked))).toEqual(["Let the agent run: {\"command\":\"git push\"}", "Let the agent run: {\"command\":\"git status\"}"])
    expect(journal.flatMap((record) => Option.toArray(dataOf(decidedEvent, record))).map((one) => one.decision._tag)).toEqual(["Refused", "Approved"])
    expect(results(journal).map(([, failed]) => failed)).toEqual([true, false])
    expect(ran).toEqual(["git status"])
  })
})
