// Lesson 9's four files, compiled as written, type-checked, and run on the
// kernel with a scripted model and a scripted host: `forget` asks before it
// deletes, a yes lets it run, a no is the failed result the model reads, and
// a yes for good is asked for once. Each text the lesson derives is checked
// against the text it starts from, and the program that provides no
// `Approval` is checked not to compile.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import type { LanguageModel } from "effect/ai"
import { Approval, APPROVAL_REFUSED, scriptedModel } from "@xandreed/sdk"
import type { ApprovalRequest, Decision, ModelScript } from "@xandreed/sdk"
import { BASE_AGENT, IMPORTS as BASE_IMPORTS } from "../base/agent.source.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS as FIRST_TOOLS, TOOLS_IMPORTS as FIRST_IMPORTS } from "../tools/tools.source.ts"
import { APPROVAL_COMMENT, APPROVAL_LINE, DEFAULT_AGENT, documentOf, IMPORTS, moduleOf, REPLACED as AGENT_REPLACED, REPLACED_IMPORTS as AGENT_REPLACED_IMPORTS } from "./agent.source.ts"
import { ASK_THEN_RUN, askInLoop, autoApproved, noApproval, noAsk, NOBODY_LINE, POLICY_LINE } from "./config-edit.ts"
import { ASK, DEFAULT_TOOLS, FORGET, FORGET_HANDLER, REPLACED, REPLACED_IMPORTS, toolsDocumentOf, toolsModuleOf } from "./tools.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

interface Shown {
  readonly replies: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
  readonly status: ReadonlyArray<string>
}

const write = (name: string, agent: string = DEFAULT_AGENT, tools: string = DEFAULT_TOOLS) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(agent))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(tools))
  return new URL("./agent.ts", at)
}

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (approvalOn: (pane: Pane) => Layer.Layer<Approval>, pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/**
 * Run `main` from the module at `file` with the scripted model and a host that answers each question from
 * `answers`, in order, and with a no once they end. `messages` are sent one by one, each once the one before it is
 * answered; it stops when each has its reply or its error. What comes back: what was shown, every prompt the model
 * received, and every question the host was asked.
 */
const runMain = (file: URL, messages: ReadonlyArray<string>, script: ModelScript, answers: ReadonlyArray<Decision>) => Effect.gen(function* () {
  const { run }: { readonly run: Run } = yield* Effect.promise(() => import(file.href))
  const { model, calls } = yield* scriptedModel(script)
  const asked = yield* Ref.make<ReadonlyArray<ApprovalRequest>>([])
  // Who is asked, for a test: typed as the contract is, a decision for each request.
  const host = Layer.succeed(Approval, Approval.of({
    ask: (request) => Effect.map(Ref.updateAndGet(asked, (all) => [...all, request]), (all): Decision => answers[all.length - 1] ?? { _tag: "Refused" }),
  }))
  const shown = yield* Ref.make<Shown>({ replies: [], errors: [], status: [] })
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  let send: (text: string) => void = () => {}
  const note = (key: keyof Shown, text: string) => Effect.runSync(Ref.update(shown, (all) => ({ ...all, [key]: [...all[key], text] })))
  // One more answer is there: the next message goes, or the run is over.
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
    showStatus: (text) => note("status", text),
  }
  const program = yield* Effect.forkChild(run(() => host, pane, model))
  const given = yield* Deferred.await(sent)
  given(messages[0] ?? "")
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), calls: yield* calls, asked: yield* Ref.get(asked) }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const SYSTEM = "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."

const calls = (...made: ReadonlyArray<{ readonly name: string; readonly params: Record<string, string> }>) => ({ _tag: "Calls" as const, pieces: [], calls: made })
const says = (text: string) => ({ _tag: "Answers" as const, pieces: [text] })
const remember = (note: string) => ({ name: "remember", params: { note } })
const forget = { name: "forget", params: {} }
const recall = { name: "recall", params: {} }

/** Two notes saved in one step, then `forget`: the turn every story here starts with. */
const twoNotesThenForget = [calls(remember("buy milk"), remember("call Ana")), calls(forget), says("Done.")]
/** What the model was sent before it asked for `forget`: the system text, the message, the two calls and their results. */
const BEFORE_FORGET = [
  { role: "system", text: SYSTEM },
  { role: "user", text: "Forget my notes." },
  { role: "assistant", text: 'remember({"note":"buy milk"})remember({"note":"call Ana"})' },
  { role: "tool", text: '→ "Saved. 1 notes so far."' },
  { role: "tool", text: '→ "Saved. 2 notes so far."' },
]
const ASKED = { action: "notes.forget", detail: "Delete all 2 notes." }

describe("lesson 9's displayed program", () => {
  test("lesson 2's tools and the base program still hold what this lesson replaces in them, and nothing else differs", () => {
    for (const [from] of REPLACED) expect({ from, held: FIRST_TOOLS.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of REPLACED_IMPORTS) expect({ from, held: FIRST_IMPORTS.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of AGENT_REPLACED) expect({ from, held: BASE_AGENT.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of AGENT_REPLACED_IMPORTS) expect({ from, held: BASE_IMPORTS.split(from).length - 1 }).toEqual({ from, held: 1 })
    // tools.ts beside lesson 2's: one import, the tool with its comment, the toolkit's line, and the handler.
    const ours = toolsDocumentOf(DEFAULT_TOOLS).split("\n")
    const first = `${FIRST_IMPORTS}\n\n${FIRST_TOOLS}\n`.split("\n")
    expect(ours.filter((line) => !first.includes(line))).toEqual([
      'import { Approval, approve, CurrentTurn } from "@xandreed/sdk"',
      "// forget deletes every note. That should not happen on a model's word alone, so it asks first.",
      'const forget = Tool.make("forget", {',
      '  description: "Delete every note saved with remember.",',
      "  // A refusal goes back to the model as the tool's answer.",
      "  // A tool that asks declares who it asks, and the turn it asks in.",
      "  dependencies: [Approval, CurrentTurn],",
      "export const tools = Toolkit.make(calculator, remember, recall, forget)",
      "  forget: () =>",
      "    Effect.gen(function* () {",
      "      // Nothing below this line runs unless the answer is yes.",
      '      yield* approve({ action: "notes.forget", detail: `Delete all ${notes.length} notes.` })',
      "      const count = notes.splice(0).length",
      "      return `Deleted ${count} notes.`",
    ])
    expect(first.filter((line) => !ours.includes(line))).toEqual(["export const tools = Toolkit.make(calculator, remember, recall)"])
    // The question is the handler's first line: nothing of the handler is above it.
    expect(FORGET_HANDLER.startsWith(`  forget: () =>\n    Effect.gen(function* () {\n${ASK}`)).toBe(true)
    expect(DEFAULT_TOOLS).toContain(FORGET)
    // A tool that asks declares a failure that is text, returned to the model: a refusal is its failed result.
    expect(FORGET).toContain('  success: Schema.String,\n  failure: Schema.String,\n  // A refusal goes back to the model as the tool\'s answer.\n  failureMode: "return",\n')
    // remember and recall do not ask: the one `approve` of the file is forget's.
    expect(DEFAULT_TOOLS.split("approve(").length - 1).toBe(1)
    // agent.ts beside the base: one comment line and one line of main. The loop is the base's.
    expect(DEFAULT_AGENT.split("\n").filter((line) => !BASE_AGENT.split("\n").includes(line))).toEqual([APPROVAL_COMMENT.trimEnd(), APPROVAL_LINE.trimEnd()])
    expect(BASE_AGENT.split("\n").filter((line) => !DEFAULT_AGENT.split("\n").includes(line))).toEqual([])
    expect(DEFAULT_AGENT).toContain("yield* callTool(toolkit, call, session)")
    // Its imports beside the base's: the three names two experiments use.
    expect(IMPORTS.split("\n").filter((line) => !BASE_IMPORTS.split("\n").includes(line))).toEqual([
      'import { Core, kernel, Sessions, toolResult, turnStartedEvent, userMessage } from "@xandreed/core"',
      'import { approveIn, autoApprove, callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk"',
    ])
    // `approvalOn` is named by no import: it is the page's, as `pane` and `model` are, and main's comment says so.
    expect(IMPORTS).not.toContain("approvalOn")
    expect(documentOf(DEFAULT_AGENT)).toContain("// `pane` and `model` come from the page: the chat on the right, and the model you picked.\n// So does `approvalOn`: who a tool asks is the host's part, and here the host is this page.\n")
    // The approval is given to the program, right after the tools' handlers.
    expect(DEFAULT_AGENT).toContain(`  Effect.provide(toolsLive), // what each tool does when it is called\n${APPROVAL_LINE}`)
  })

  test("each experiment changes the lines it names, and no other", () => {
    const changed = (before: string, after: string) => ({
      gone: before.split("\n").filter((line) => !after.split("\n").includes(line)),
      come: after.split("\n").filter((line) => !before.split("\n").includes(line)),
    })
    expect(changed(DEFAULT_AGENT, Option.getOrThrow(autoApproved(DEFAULT_AGENT)))).toEqual({ gone: [APPROVAL_LINE.trimEnd()], come: [POLICY_LINE.trimEnd()] })
    expect(changed(DEFAULT_AGENT, Option.getOrThrow(noApproval(DEFAULT_AGENT)))).toEqual({ gone: [APPROVAL_LINE.trimEnd()], come: [NOBODY_LINE.trimEnd()] })
    expect(Option.getOrThrow(noApproval(DEFAULT_AGENT))).not.toContain("approvalOn(")
    expect(changed(DEFAULT_AGENT, Option.getOrThrow(askInLoop(DEFAULT_AGENT)))).toEqual({ gone: ["          yield* callTool(toolkit, call, session)"], come: ASK_THEN_RUN.trimEnd().split("\n") })
    expect(changed(DEFAULT_TOOLS, Option.getOrThrow(noAsk(DEFAULT_TOOLS)))).toEqual({ gone: ASK.trimEnd().split("\n"), come: [] })
    expect(Option.getOrThrow(noAsk(DEFAULT_TOOLS))).not.toContain("approve(")
    // A line the learner rewrote is left alone.
    expect(autoApproved(DEFAULT_AGENT.replace("approvalOn(pane)", "approvalOn(chatPane)"))).toEqual(Option.none())
    expect(noApproval(DEFAULT_AGENT.replace("approvalOn(pane)", "approvalOn(chatPane)"))).toEqual(Option.none())
    expect(askInLoop(DEFAULT_AGENT.replace("callTool(toolkit, call, session)", "callTool(toolkit, call, opened)"))).toEqual(Option.none())
    expect(noAsk(DEFAULT_TOOLS.replace('action: "notes.forget"', 'action: "notes.delete"'))).toEqual(Option.none())
  })

  test("approved, forget runs: the host was asked once, in the tool's words, and the model reads what was deleted", async () => {
    const result = await Effect.runPromise(runMain(write("approved"), ["Forget my notes."], twoNotesThenForget, [{ _tag: "Approved" }]))
    expect(result.shown.errors).toEqual([])
    expect(result.shown.replies).toEqual(["Done."])
    expect(result.asked).toEqual([ASKED])
    expect(result.calls[1]).toEqual(BEFORE_FORGET)
    expect(result.calls[2]).toEqual([...BEFORE_FORGET, { role: "assistant", text: "forget({})" }, { role: "tool", text: '→ "Deleted 2 notes."' }])
  })

  test("refused, forget does not run: the model reads the refusal as the call's failed result, in the kernel's words, and the notes are still there", async () => {
    const result = await Effect.runPromise(runMain(write("refused"), ["Forget my notes.", "What are my notes?"], [...twoNotesThenForget, calls(recall), says("Two notes.")], [{ _tag: "Refused" }]))
    expect(result.shown.errors).toEqual([])
    expect(result.shown.replies).toEqual(["Done.", "Two notes."])
    expect(result.asked).toEqual([ASKED])
    expect(APPROVAL_REFUSED).toBe("The user did not approve this action, so it was not done. Do not try it again unless the user asks for it.")
    // The turn goes on: the model is asked again, with the refusal as the tool's answer.
    expect(result.calls[2]).toEqual([...BEFORE_FORGET, { role: "assistant", text: "forget({})" }, { role: "tool", text: `→ failed: ${JSON.stringify(APPROVAL_REFUSED)}` }])
    // The next turn reads the notes back: both are there.
    expect(result.calls[4]?.at(-1)).toEqual({ role: "tool", text: '→ ["buy milk","call Ana"]' })
  })

  test("approved for good, forget is asked for once for two calls: the second finds the standing approval in the journal", async () => {
    const result = await Effect.runPromise(runMain(write("always"), ["Forget my notes.", "And again."], [...twoNotesThenForget, calls(forget), says("Done again.")], [{ _tag: "ApprovedAlways" }]))
    expect(result.shown.errors).toEqual([])
    expect(result.shown.replies).toEqual(["Done.", "Done again."])
    // The host's list holds one answer: a second question would have been refused.
    expect(result.asked).toEqual([ASKED])
    expect(result.calls[2]?.at(-1)).toEqual({ role: "tool", text: '→ "Deleted 2 notes."' })
    expect(result.calls[4]?.at(-1)).toEqual({ role: "tool", text: '→ "Deleted 0 notes."' })
  })

  test("with a policy that allows everything (an experiment), the host is never asked, and forget runs", async () => {
    const result = await Effect.runPromise(runMain(write("policy", Option.getOrThrow(autoApproved(DEFAULT_AGENT))), ["Forget my notes."], twoNotesThenForget, []))
    expect(result.asked).toEqual([])
    expect(result.calls[2]?.at(-1)).toEqual({ role: "tool", text: '→ "Deleted 2 notes."' })
  })

  test("a loop that asks before every call (an experiment) asks for each tool, and for forget twice: once by the loop, once by the tool", async () => {
    const yes: Decision = { _tag: "Approved" }
    const result = await Effect.runPromise(runMain(write("loop", Option.getOrThrow(askInLoop(DEFAULT_AGENT))), ["Forget my notes."], twoNotesThenForget, [yes, yes, yes, yes]))
    expect(result.asked).toEqual([
      { action: "tool.remember", detail: 'Call remember with {"note":"buy milk"}.' },
      { action: "tool.remember", detail: 'Call remember with {"note":"call Ana"}.' },
      { action: "tool.forget", detail: "Call forget with {}." },
      ASKED,
    ])
    expect(result.calls[2]?.at(-1)).toEqual({ role: "tool", text: '→ "Deleted 2 notes."' })
    // Refused by the loop, a call has the refusal as its result, and the tool never runs: its own question is not asked.
    const refused = await Effect.runPromise(runMain(write("loop-refused", Option.getOrThrow(askInLoop(DEFAULT_AGENT))), ["Forget my notes."], twoNotesThenForget, [yes, yes]))
    expect(refused.asked.map((request) => request.action)).toEqual(["tool.remember", "tool.remember", "tool.forget"])
    expect(refused.calls[2]?.at(-1)).toEqual({ role: "tool", text: `→ failed: ${JSON.stringify(APPROVAL_REFUSED)}` })
  })

  test("without the line that asks (an experiment), forget deletes on the model's word: nobody is asked", async () => {
    const result = await Effect.runPromise(runMain(write("no-ask", DEFAULT_AGENT, Option.getOrThrow(noAsk(DEFAULT_TOOLS))), ["Forget my notes."], twoNotesThenForget, []))
    expect(result.asked).toEqual([])
    expect(result.calls[2]?.at(-1)).toEqual({ role: "tool", text: '→ "Deleted 2 notes."' })
  })

  test("each line this lesson adds to the shown files fits 100 columns", () => {
    const added = [FORGET, FORGET_HANDLER, APPROVAL_COMMENT, APPROVAL_LINE, POLICY_LINE, NOBODY_LINE, ASK_THEN_RUN]
    expect(added.flatMap((text) => text.split("\n")).filter((line) => line.length > 100)).toEqual([])
  })

  test("type-level: the program that provides no Approval, as the no-approval experiment leaves it, does not compile, and the compiler names what is missing", () => {
    // `run` says its program needs nothing more. forget declares `Approval`, so a call of the toolkit needs it: take
    // main's line away, and tsc refuses the program where its type is written out.
    write("missing/approval", Option.getOrThrow(noApproval(DEFAULT_AGENT)))
    const missing = new URL("./missing/tsconfig.json", dir)
    writeFileSync(missing, JSON.stringify({ extends: "../../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(missing)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    const said = `${checked.stdout.toString()}${checked.stderr.toString()}`
    rmSync(new URL("./missing/", dir), { recursive: true, force: true })
    expect(checked.exitCode).not.toBe(0)
    expect(said).toContain("agent.ts")
    expect(said).toContain("Type 'Approval' is not assignable to type 'never'")
    // It is the one error: nothing else of the four files is wrong.
    expect(said.split("\n").filter((line) => line.includes("error TS"))).toHaveLength(1)
  }, 120_000)

  test("type-checks as TypeScript, all four files, as shown and as each experiment that provides an approval leaves them", () => {
    write("typed")
    write("typed-policy", Option.getOrThrow(autoApproved(DEFAULT_AGENT)))
    write("typed-loop", Option.getOrThrow(askInLoop(DEFAULT_AGENT)))
    write("typed-no-ask", DEFAULT_AGENT, Option.getOrThrow(noAsk(DEFAULT_TOOLS)))
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
