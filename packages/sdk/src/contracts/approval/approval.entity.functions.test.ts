import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { kernel, Seq, Sessions, TurnNumber, userMessage } from "@xandreed/core"
import type { StoredDraft, StoredEvent } from "@xandreed/core"
import { callTool, CurrentTurn, inProcessJournal, sessions } from "../../index.js"
import { approve, decided, grantsOf } from "./approval.entity.functions.js"
import { Approval } from "./approval.port.js"

const journalOf = (drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> =>
  drafts.map((draft, index) => ({ ...draft, seq: Seq.make(index + 1), at: 1_767_225_600_000, turn: TurnNumber.make(1) }))
const request = (action: string) => ({ action, detail: `Do ${action}.` })

describe("standing approvals", () => {
  test("grantsOf is each action approved for good, once, in the order first granted; other answers and other records grant nothing", () => {
    expect(grantsOf(journalOf([
      userMessage("go"),
      decided(request("files.write"), { _tag: "Approved" }),
      decided(request("notes.forget"), { _tag: "ApprovedAlways" }),
      decided(request("files.delete"), { _tag: "Refused" }),
      decided(request("mail.send"), { _tag: "Allowed" }),
      decided(request("files.write"), { _tag: "ApprovedAlways" }),
      decided(request("notes.forget"), { _tag: "ApprovedAlways" }),
    ]))).toEqual(["notes.forget", "files.write"])
    expect(grantsOf([])).toEqual([])
  })
})

describe("approve, in a tool's handler", () => {
  // A tool that asks declares a failure that is text: a refusal fails its call with the words the model reads. The
  // compiler holds a typed handler to that. `bare` declares none, as untyped code may: its handler is cast.
  const Act = Tool.make("act", { success: Schema.String, failure: Schema.String, failureMode: "return", dependencies: [Approval, CurrentTurn] })
  const Sloppy = Tool.make("sloppy", { success: Schema.String, failure: Schema.String, failureMode: "return", dependencies: [Approval, CurrentTurn] })
  const Bare = Tool.make("bare", { success: Schema.String, dependencies: [Approval, CurrentTurn] })
  const Long = Tool.make("long", { success: Schema.String, failure: Schema.String, failureMode: "return", dependencies: [Approval, CurrentTurn] })
  const Named = Tool.make("named", { success: Schema.String, failure: Schema.String, failureMode: "return", dependencies: [Approval, CurrentTurn] })
  const tools = Toolkit.make(Act, Sloppy, Bare, Long, Named)
  /** One call of a tool in an open turn, over a host that answers `answered`: the stored result, what ran, and how often the host was asked. */
  const called = (name: "act" | "sloppy" | "bare" | "long" | "named", answered: Effect.Effect<unknown>, hosted = true) => {
    let ran = 0
    let asked = 0
    const asking = (action: string, detail = "Act.") => Effect.gen(function* () { yield* approve({ action, detail }); ran += 1; return "done" })
    const details: Array<string> = []
    const handlers = tools.toLayer({ act: () => asking("act"), sloppy: () => asking(""), bare: (() => asking("act")) as never, long: () => asking("act", "é".repeat(2600)), named: () => asking("a".repeat(201)) })
    const host = hosted ? Layer.succeed(Approval, Approval.of({ ask: (request) => Effect.flatMap(Effect.sync(() => { asked += 1; details.push(request.detail) }), () => answered) as never })) : Layer.empty
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const all = yield* Sessions
      const session = yield* all.open(yield* all.create({ owner: "test" }))
      yield* session.append(userMessage("go"))
      const stored = yield* callTool(yield* tools, { id: "c1", name, params: {} }, session)
      const message = stored.message?._tag === "ToolResult" ? [stored.message.result, stored.message.isFailure] : []
      return { message, ran, asked, details, records: (yield* session.journal).map((event) => String(event.name)).slice(2) }
    }) as Effect.Effect<{ message: ReadonlyArray<unknown>; ran: number; asked: number; details: ReadonlyArray<string>; records: ReadonlyArray<string> }, unknown, Sessions>).pipe(Effect.provide(Layer.mergeAll(handlers, host, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))))))
  }

  test("a refusal is the failed result the model reads, and the handler's work does not run; an approval lets it run", async () => {
    const REFUSED = "The user did not approve this action, so it was not done. Do not try it again unless the user asks for it."
    expect(await called("act", Effect.succeed({ _tag: "Refused" }))).toEqual({ message: [REFUSED, true], ran: 0, asked: 1, details: ["Act."], records: ["plugin.approval.decided", "conversation.tool.result"] })
    expect(await called("act", Effect.succeed({ _tag: "Approved" }))).toMatchObject({ message: ["done", false], ran: 1, asked: 1 })
    // Untyped code that declares no failure on its tool reads the same refusal.
    expect(await called("bare", Effect.succeed({ _tag: "Refused" }))).toMatchObject({ message: [REFUSED, true], ran: 0, asked: 1 })
  })

  test("a host that dies while it is asked approves nothing: the work does not run, and no decision is stored", async () => {
    expect(await called("act", Effect.die(new Error("the page was closed")))).toEqual({ message: ["the page was closed", true], ran: 0, asked: 1, details: ["Act."], records: ["conversation.tool.result"] })
  })

  test("a request that names no action, or one over 200 characters, is the tool's mistake: nobody is asked, the work does not run, and the result says what approve needs", async () => {
    const NEEDS = "approve needs an action, a text of 1 to 200 characters, and a detail that is not empty: approve({ action: \"notes.forget\", detail: \"Forget all 3 notes.\" })"
    expect(await called("sloppy", Effect.succeed({ _tag: "Approved" }))).toEqual({ message: [NEEDS, true], ran: 0, asked: 0, details: [], records: ["conversation.tool.result"] })
    expect(await called("named", Effect.succeed({ _tag: "Approved" }))).toMatchObject({ message: [NEEDS, true], ran: 0, asked: 0 })
  })

  test("a detail longer than a person is asked to read is cut, with what was cut counted, and the person is asked all the same", async () => {
    const out = await called("long", Effect.succeed({ _tag: "Approved" }))
    expect(out).toMatchObject({ message: ["done", false], ran: 1, asked: 1 })
    expect(out.details).toEqual([`${"é".repeat(1960)} [… 640 characters clipped]`])
    expect(out.details[0]!.length).toBeLessThanOrEqual(2000)
  })

  test("with nobody to ask in the stack, the tool does not act, and its call fails", async () => {
    // Typed code does not compile without `Approval` (composition.test.ts). Untyped code runs: this is what it gets.
    const out = await called("act", Effect.succeed({ _tag: "Approved" }), false)
    expect(out).toEqual({ message: ["Service not found: @xandreed/sdk/Approval", true], ran: 0, asked: 0, details: [], records: ["conversation.tool.result"] })
  })

  test("a question dropped with its turn decides nothing: no record is stored, and the work does not run", async () => {
    let ran = 0
    const handlers = tools.toLayer({ act: () => Effect.gen(function* () { yield* approve({ action: "act", detail: "Act." }); ran += 1; return "done" }), sloppy: () => Effect.succeed(""), bare: (() => Effect.succeed("")) as never, long: () => Effect.succeed(""), named: () => Effect.succeed("") })
    const names = await Effect.runPromise(Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>()
      // A person who never answers: the question waits until the turn is dropped.
      const host = Layer.succeed(Approval, Approval.of({ ask: () => Effect.andThen(Deferred.succeed(waiting, undefined), Effect.never) }))
      return yield* Effect.gen(function* () {
        const all = yield* Sessions
        const id = yield* all.create({ owner: "test" })
        const turn = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
          const session = yield* all.open(id)
          yield* session.append(userMessage("go"))
          yield* callTool(yield* tools, { id: "c1", name: "act", params: {} }, session)
        })))
        yield* Deferred.await(waiting)
        yield* Fiber.interrupt(turn)
        return (yield* all.read(id)).events.map((event) => String(event.name))
      }).pipe(Effect.provide(Layer.mergeAll(handlers, host, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel())))))
    }))
    expect(ran).toBe(0)
    // The turn's start, its message and its end: no decision, and no result.
    expect(names).toEqual(["core.session.turn.started", "conversation.user.message", "core.session.turn.ended"])
  })
})
