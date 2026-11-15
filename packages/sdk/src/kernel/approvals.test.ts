import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { dataOf, kernel, messageOf, Sessions, toolResult, userMessage } from "@xandreed/core/kernel"
import type { SessionId, StoredEvent } from "@xandreed/core/kernel"
import {
  Approval, APPROVAL_REFUSED, approve, approveIn, autoApprove, callTool, CurrentTurn, decidedEvent, flatMemory, grantsOf, inProcessJournal, Memory, modelAnswer, scriptedModel,
  sessions, webStorageJournal,
} from "./index.js"
import type { ApprovalRequest, Decision, KeyValueStore, ModelScript } from "./index.js"

/*
 * Approvals (ADR 0012), as a test: a tool asks a person before it acts,
 * through a contract the host provides, and the answer is a record of the
 * turn. `docs/kernel.md` quotes the tool and the host's part.
 */

// #region tool
// The notes a tool keeps, and a tool that deletes them. Deleting asks first: one line at the start of the handler.
const notes: Array<string> = ["buy milk", "call Ana", "water the plants"]
const Forget = Tool.make("forget", {
  description: "Delete every note.",
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
  // A tool that asks declares who it asks and the turn it asks in: without them in the stack, it does not run.
  dependencies: [Approval, CurrentTurn],
})
const tools = Toolkit.make(Forget)
const toolsLive = tools.toLayer({
  forget: () => Effect.gen(function* () {
    // Nothing below this line runs unless the answer is yes. A no fails the call with the text the model reads.
    yield* approve({ action: "notes.forget", detail: `Delete all ${notes.length} notes.` })
    const count = notes.splice(0).length
    return `Deleted ${count} notes.`
  }),
})
// #endregion tool

/** The host's part, for a test: it answers each request from a list, in order, and keeps what it was asked. */
const scripted = (answers: ReadonlyArray<Decision>) => Effect.gen(function* () {
  const asked = yield* Ref.make<ReadonlyArray<ApprovalRequest>>([])
  // #region host
  // Who is asked. A host answers from a button, a prompt or a policy: here, from a list, and with a no once it ends.
  const approval = Layer.succeed(Approval, Approval.of({
    ask: (request) => Effect.map(Ref.updateAndGet(asked, (all) => [...all, request]), (all): Decision => answers[all.length - 1] ?? { _tag: "Refused" }),
  }))
  // #endregion host
  return { approval, asked: Ref.get(asked) }
})

/** A host written without types, as a page's code is: it answers with whatever it was given, a decision or not. */
const untyped = (answer: unknown) => Layer.succeed(Approval, Approval.of({ ask: () => Effect.succeed(answer as Decision) }))

const SYSTEM = "Use a tool when it helps."
const calls = (count: number): ModelScript => Array.from({ length: count }, () => [
  { _tag: "Calls" as const, pieces: [], calls: [{ name: "forget", params: {} }] },
  { _tag: "Answers" as const, pieces: ["Done."] },
]).flat()

/** A host's turn with tools, one message a turn, over the storage it is given: the journal after, and what the model was sent. */
const run = (script: ModelScript, messages: ReadonlyArray<string>, approval: Layer.Layer<Approval>, journalLayer = inProcessJournal(), resume = false) => Effect.gen(function* () {
  const { model, calls: sent } = yield* scriptedModel(script)
  const turn = (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
    const memory = yield* Memory
    const language = yield* LanguageModel.LanguageModel
    const toolkit = yield* tools
    const session = yield* (yield* Sessions).open(conversation)
    yield* session.append(userMessage(message))
    for (let step = 1; step <= 4; step++) {
      const prompt = Prompt.make([{ role: "system", content: SYSTEM }, ...(yield* memory.context(session))])
      const answer = yield* modelAnswer(language.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
      if (answer.toolCalls.length === 0) return answer.text
      for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
    }
    return "stopped"
  }))
  const journal = yield* Effect.gen(function* () {
    const all = yield* Sessions
    const found = resume ? (yield* all.list)[0] : undefined
    const conversation = found === undefined ? yield* all.create({ owner: "test" }) : found.id
    yield* Effect.forEach(messages, (message) => turn(conversation, message), { concurrency: 1, discard: true })
    return (yield* all.read(conversation)).events
  }).pipe(Effect.provide(Layer.mergeAll(model, toolsLive, approval, flatMemory, sessions().pipe(Layer.provideMerge(journalLayer), Layer.provideMerge(kernel())))))
  return { journal, sent: yield* sent }
})

const decisions = (journal: ReadonlyArray<StoredEvent>) => journal.flatMap((record) => Option.toArray(dataOf(decidedEvent, record)))
const results = (journal: ReadonlyArray<StoredEvent>) =>
  journal.flatMap((record) => Option.toArray(messageOf(record))).flatMap((message) => (message._tag === "ToolResult" ? [[message.result, message.isFailure]] : []))
const fill = () => { notes.splice(0, notes.length, "buy milk", "call Ana", "water the plants") }

describe("approvals", () => {
  test("a tool asks before it acts: approved, it runs, and the answer is a record of the turn", async () => {
    fill()
    // #region ask
    const { journal, asked } = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* scripted([{ _tag: "Approved" }])
      const ran = yield* run(calls(1), ["Forget my notes."], host.approval)
      return { ...ran, asked: yield* host.asked }
    }))
    // The person was asked once, in the tool's words.
    expect(asked).toEqual([{ action: "notes.forget", detail: "Delete all 3 notes." }])
    // The answer is stored in the turn, between the call and its result. It bears no message: no memory sends it.
    expect(journal.map((record) => String(record.name))).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message",
      "plugin.approval.decided", "conversation.tool.result", "conversation.assistant.message", "core.session.turn.ended",
    ])
    expect(decisions(journal)).toEqual([{ action: "notes.forget", detail: "Delete all 3 notes.", decision: { _tag: "Approved" } }])
    expect(results(journal)).toEqual([["Deleted 3 notes.", false]])
    // #endregion ask
    expect(notes).toEqual([])
  })

  test("refused, the tool does not act, and the model reads the refusal as the call's result, in fixed words", async () => {
    fill()
    const { journal, sent } = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* scripted([{ _tag: "Refused" }])
      return yield* run(calls(1), ["Forget my notes."], host.approval)
    }))
    expect(APPROVAL_REFUSED).toBe("The user did not approve this action, so it was not done. Do not try it again unless the user asks for it.")
    expect(results(journal)).toEqual([[APPROVAL_REFUSED, true]])
    expect(decisions(journal).map((one) => one.decision._tag)).toEqual(["Refused"])
    expect(notes).toEqual(["buy milk", "call Ana", "water the plants"])
    // The turn goes on: the model is asked again, with the refusal as the tool's answer.
    expect(sent[1]?.at(-1)).toEqual({ role: "tool", text: `→ failed: ${JSON.stringify(APPROVAL_REFUSED)}` })
  })

  test("approved for good, the action is not asked again in that conversation: the grant is the record", async () => {
    fill()
    const { journal, asked } = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* scripted([{ _tag: "ApprovedAlways" }])
      const ran = yield* run(calls(2), ["Forget my notes.", "And again."], host.approval)
      return { ...ran, asked: yield* host.asked }
    }))
    // Asked once for two calls, and one record: the second call found the grant in the journal.
    expect(asked).toHaveLength(1)
    expect(decisions(journal).map((one) => one.decision._tag)).toEqual(["ApprovedAlways"])
    expect(grantsOf(journal)).toEqual(["notes.forget"])
    expect(results(journal)).toEqual([["Deleted 3 notes.", false], ["Deleted 0 notes.", false]])
  })

  test("a grant is its record: a second process over the same storage finds it, and another conversation does not have it", async () => {
    fill()
    const values = new Map<string, string>()
    const storage: KeyValueStore = {
      get length() { return values.size },
      key: (index) => Array.from(values.keys())[index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: (key) => { values.delete(key) },
    }
    const durable = () => webStorageJournal(storage, { prefix: "agent:" })
    const first = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* scripted([{ _tag: "ApprovedAlways" }])
      yield* run(calls(1), ["Forget my notes."], host.approval, durable())
      return yield* host.asked
    }))
    expect(first).toHaveLength(1)
    // A new process, the same conversation: nobody is asked.
    const second = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* scripted([{ _tag: "Refused" }])
      const ran = yield* run(calls(1), ["Forget them again."], host.approval, durable(), true)
      return { asked: yield* host.asked, results: results(ran.journal) }
    }))
    expect(second.asked).toEqual([])
    expect(second.results.at(-1)).toEqual(["Deleted 0 notes.", false])
    // Another conversation has a journal of its own, and no grant in it.
    const other = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* scripted([{ _tag: "Refused" }])
      const ran = yield* run(calls(1), ["Forget my notes."], host.approval)
      return { asked: yield* host.asked, results: results(ran.journal) }
    }))
    expect(other.asked).toHaveLength(1)
    expect(other.results).toEqual([[APPROVAL_REFUSED, true]])
  })

  test("an answer that is no decision approves nothing: the tool does not act, and nothing is stored, since nobody decided", async () => {
    for (const garbage of [true, undefined, "yes", { _tag: "Aproved" }, { approved: true }]) {
      fill()
      const { journal } = await Effect.runPromise(run(calls(1), ["Forget my notes."], untyped(garbage)))
      expect(results(journal)).toEqual([[APPROVAL_REFUSED, true]])
      expect(decisions(journal)).toEqual([])
      expect(notes).toHaveLength(3)
    }
  })

  test("a policy before the person: what it allows is answered Allowed with nobody asked, and it never grants for good", async () => {
    fill()
    const { journal, asked } = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* scripted([{ _tag: "Refused" }])
      const policy = autoApprove((request) => request.action.startsWith("notes."))(host.approval)
      const ran = yield* run(calls(2), ["Forget my notes.", "And again."], policy)
      return { ...ran, asked: yield* host.asked }
    }))
    expect(asked).toEqual([])
    // Each call is allowed and recorded as the policy's, never as a person's: no grant stands.
    expect(decisions(journal).map((one) => one.decision._tag)).toEqual(["Allowed", "Allowed"])
    expect(grantsOf(journal)).toEqual([])
    // What the policy does not allow goes to the person.
    fill()
    const strict = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* scripted([{ _tag: "Refused" }])
      const ran = yield* run(calls(1), ["Forget my notes."], autoApprove(() => false)(host.approval))
      return { asked: yield* host.asked, results: results(ran.journal) }
    }))
    expect(strict.asked).toHaveLength(1)
    expect(strict.results).toEqual([[APPROVAL_REFUSED, true]])
  })

  test("a loop that asks before every call stores a refusal as the call's result, in the same words", async () => {
    fill()
    const Plain = Tool.make("wipe", { description: "Delete every note.", success: Schema.String })
    const plainTools = Toolkit.make(Plain)
    const out = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* scripted([{ _tag: "Refused" }, { _tag: "Approved" }])
      const { model, calls: sent } = yield* scriptedModel([
        { _tag: "Calls", pieces: [], calls: [{ name: "wipe", params: {} }] }, { _tag: "Answers", pieces: ["I did not."] },
        { _tag: "Calls", pieces: [], calls: [{ name: "wipe", params: {} }] }, { _tag: "Answers", pieces: ["Done."] },
      ])
      const turn = (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
        const memory = yield* Memory
        const language = yield* LanguageModel.LanguageModel
        const toolkit = yield* plainTools
        const session = yield* (yield* Sessions).open(conversation)
        yield* session.append(userMessage(message))
        for (let step = 1; step <= 4; step++) {
          const prompt = Prompt.make([{ role: "system", content: SYSTEM }, ...(yield* memory.context(session))])
          const answer = yield* modelAnswer(language.streamText({ prompt, toolkit: plainTools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
          if (answer.toolCalls.length === 0) return answer.text
          for (const call of answer.toolCalls) {
            // The loop asks for every call, whatever the tool: a refusal is the call's result, or the call would be sent with none.
            yield* approveIn(session, { action: `tool.${call.name}`, detail: `Call ${call.name}.` }).pipe(Effect.matchEffect({
              onFailure: (refusal) => session.append(toolResult(call, refusal, true)),
              onSuccess: () => callTool(toolkit, call, session),
            }))
          }
        }
        return "stopped"
      }))
      const journal = yield* Effect.gen(function* () {
        const all = yield* Sessions
        const conversation = yield* all.create({ owner: "test" })
        yield* turn(conversation, "Wipe my notes.")
        yield* turn(conversation, "Yes, do it.")
        return (yield* all.read(conversation)).events
      }).pipe(Effect.provide(Layer.mergeAll(model, plainTools.toLayer({ wipe: () => Effect.sync(() => `Deleted ${notes.splice(0).length} notes.`) }), host.approval, flatMemory, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel())))))
      return { journal, sent: yield* sent }
    }))
    expect(results(out.journal)).toEqual([[APPROVAL_REFUSED, true], ["Deleted 3 notes.", false]])
    expect(out.sent[1]?.at(-1)).toEqual({ role: "tool", text: `→ failed: ${JSON.stringify(APPROVAL_REFUSED)}` })
    expect(decisions(out.journal).map((one) => [one.action, one.decision._tag])).toEqual([["tool.wipe", "Refused"], ["tool.wipe", "Approved"]])
  })
})
