// Lesson 14 on the page's runtime, with Echo picked and Echo as the spare:
// failures.ts makes the calls of the model picked fail, one entry a call; the
// plan tries the call again or hands it to the spare; an answer cut after a
// word is final. Each claim of the page and each experiment is pinned here:
// the words of a made failure, which calls the list counts, what starts it
// again, Stop during the wait, the Context tab's pairing of a failed attempt,
// the spare named in the record and the trace, the chat drawn again from the
// journal, and what the page says of a program whose model call has no model.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Duration, Effect, Exit, Layer, Option, Result, Stream } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import { dataOf, turnEndedEvent } from "@xandreed/core/kernel"
import { attemptEvent, retryable, Summarizer } from "@xandreed/sdk/kernel"
import { attemptLine, chatRowsOf, emptyChat, failureLine, hear, sent } from "../../chat-model.ts"
import type { ChatBoard, ChatRow } from "../../chat-model.ts"
import { applyExperiment } from "../../lesson.ts"
import type { Lesson } from "../../lesson.ts"
import { makeBrowserModel } from "../../models/make.ts"
import { echoChoice, loadEcho } from "../../models/mock.ts"
import { aiError } from "../../models/stream.ts"
import type { LoadedModel } from "../../models/types.ts"
import { LessonRuntime, madeFailureWords, SPARE } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { emptyBoard, record, viewOf } from "../../trace-model.ts"
import { modelFailures } from "./lesson.ts"

// Echo streams a word every 35 ms, and the plan waits a second between tries.
setDefaultTimeout(60_000)

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES: Record<string, string> = Object.fromEntries(modelFailures.files.map((file) => [file.id, file.defaultText]))

/** The files as the page leaves them after an experiment: every file it edits, its own first, and the rest as they were. */
const applied = (id: string, sources = SOURCES): Record<string, string> =>
  ({ ...sources, ...Object.fromEntries(Option.getOrThrow(applyExperiment(modelFailures.experiments[id]!, (file) => sources[file] ?? ""))) })

/** A row as a test reads it: its kind, whether a record is behind it (`*` when none), and its text. */
const told = (row: ChatRow) => `${row.kind}${row.seq === undefined ? "*" : ""}: ${row.text}`

/** The page: the runtime with `model` picked, what it heard, and the chat's rows as the page folds them. */
const page = async (sources: Record<string, string> = SOURCES, model: LoadedModel = loadEcho()) => {
  const runtime = await LessonRuntime.create(modelFailures)
  opened.push(runtime)
  runtime.setModel(model)
  const heard: Array<Trace> = []
  let board: ChatBoard = emptyChat
  runtime.onTrace((trace) => { heard.push(trace); board = hear(board, trace, runtime.conversation) })
  const result = await runtime.start(sources)
  const until = (match: (trace: Trace) => boolean) => new Promise<void>((resolve) => {
    const stop = runtime.onTrace((trace) => { if (match(trace)) { stop(); resolve() } })
  })
  const isEnd = (trace: Trace) => trace._tag === "Reply" || trace._tag === "Failed" || trace._tag === "Ended"
  /** Send as the page does: a waiting row, then the message into the queue. */
  const send = (text: string) => { board = sent(board, text); runtime.send(text) }
  /** Send each once the one before is answered: each a turn of its own. */
  const say = async (...texts: ReadonlyArray<string>) => { for (const text of texts) { const done = until(isEnd); send(text); await done } }
  /** Every prompt of the conversation shown, as the model it was sent to and the turn. */
  const prompts = () => heard.flatMap((trace) => (trace._tag === "Prompt" && trace.session === runtime.conversation ? [`${trace.model} ${trace.turn}`] : []))
  const failures = () => heard.flatMap((trace) => (trace._tag === "PromptFailed" ? [trace.reason] : []))
  /** Each attempt said live, as `outcome step.attempt`. */
  const attempts = () => heard.flatMap((trace) => (trace._tag === "Event" && trace.event._tag === "Live" ? Option.toArray(dataOf(attemptEvent, trace.event)) : []))
  const said = () => attempts().map((one) => `${one.outcome} ${one.step}.${one.attempt}`)
  const replies = () => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
  const rows = () => board.rows.map(told)
  const journal = () => runtime.journal()
  const names = async () => (await journal()).map((event): string => event.name)
  const outcomes = async () => (await journal()).flatMap((event) => Option.toArray(dataOf(turnEndedEvent, event))).map((ended) => ended.outcome._tag)
  /** The models the conversation's answers name, in order. */
  const answeredBy = async () => (await journal()).flatMap((event) => (event.message?._tag === "Assistant" && typeof event.data === "object" && event.data !== null && "model" in event.data ? [event.data.model] : []))
  const view = (turn: number) => viewOf(heard.reduce((all, trace, index) => record(all, trace, index), emptyBoard(runtime.conversation)), turn)
  return { runtime, heard, result, send, say, until, prompts, failures, attempts, said, replies, rows, journal, names, outcomes, answeredBy, view, board: () => board }
}

/** What a test's own model says an answer cost. */
const USAGE = { inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }

const HELLO = "Hello! I'm Echo, a scripted stand-in model. Ask me what you said earlier and I'll answer from the messages I was sent."
const RETRYABLE = "echo.streamText: Internal provider error: failures.ts made this call fail, and said it is worth another try"
const FOR_GOOD = "echo.streamText: failures.ts made this call fail, and did not say it is worth another try"
const CUT = "echo.streamText: Internal provider error: failures.ts made this call fail after 1 piece, and said it is worth another try"

describe("lesson 14 on the page (the kernel, Echo picked, Echo as the spare)", () => {
  test("a made failure says the page made it, from failures.ts, never the model's words: an AiError of the model picked, a provider's own error when worth another try", () => {
    expect(madeFailureWords({ retryable: true })).toBe("failures.ts made this call fail, and said it is worth another try")
    expect(madeFailureWords({})).toBe("failures.ts made this call fail, and did not say it is worth another try")
    expect(madeFailureWords({ retryable: false })).toBe("failures.ts made this call fail, and did not say it is worth another try")
    expect(madeFailureWords({ retryable: true, pieces: ["Half "] })).toBe("failures.ts made this call fail after 1 piece, and said it is worth another try")
    expect(madeFailureWords({ pieces: ["One ", "two "] })).toBe("failures.ts made this call fail after 2 pieces, and did not say it is worth another try")
    expect(SPARE).toBe("echo-spare")
  })

  test("as it starts, a message is answered on the second try: the first attempt fails, the plan waits a second, the model picked answers, and the journal is that of a call that answered at once", async () => {
    const { result, say, prompts, failures, said, replies, rows, names, answeredBy, view, heard } = await page()
    expect(result).toEqual({ _tag: "Built" })
    const started = performance.now()
    await say("Hello.")
    // The schedule: a second between the two tries.
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(prompts()).toEqual(["echo 1", "echo 1"])
    expect(failures()).toEqual([RETRYABLE])
    // Said live about the turn: the first attempt failed, in the failure's words, and the second, on the same step, answered.
    expect(said()).toEqual(["started 0.1", "failed 0.1", "started 0.2", "succeeded 0.2"])
    expect(heard.flatMap((trace) => (trace._tag === "Event" && trace.event._tag === "Live" ? Option.toArray(dataOf(attemptEvent, trace.event)) : [])).flatMap((one) => (one.reason === undefined ? [] : [one.reason]))).toEqual([RETRYABLE])
    expect(replies()).toEqual([HELLO])
    expect(rows()).toEqual(["user: Hello.", `agent: ${HELLO}`])
    // Nothing of the failed attempt is stored: the turn's four records, as for a call that answered at once.
    expect(await names()).toEqual(["core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "core.session.turn.ended"])
    expect(await answeredBy()).toEqual(["echo"])
    // The Context tab: one model call, two attempts on the model picked, then the answer. The answer is paired with
    // the second prompt, and names no model: the model picked answered.
    const turn = view(1)
    expect(turn.calls.map((call) => call.attempts.map((one) => [one.attempt, one.model, Option.getOrNull(one.failed)]))).toEqual([[[1, "echo", RETRYABLE], [2, "echo", null]]])
    expect(turn.calls.map((call) => Option.getOrNull(call.answeredBy))).toEqual([null])
    expect(turn.steps.map((step) => [step.label, step.state])).toEqual([
      ["Turn opened", "done"], ["Message stored", "done"], ["Memory built the context", "done"], ["Attempt 1 failed", "done"],
      ["Prompt sent", "done"], ["Answer streamed", "done"], ["Answer stored", "done"], ["Turn closed", "done"],
    ])
    expect(turn.steps.find((step) => step.id === "attempt-1-1")?.detail).toBe(`Attempt 1, on echo, failed: ${RETRYABLE}. It failed before a word of its answer, so nothing of it was shown or stored. Then the call was tried again: attempt 2, on echo.`)
    expect(turn.steps.find((step) => step.id === "prompt-1")?.detail.startsWith("Attempt 2, sent to echo. The system text from your code, 1 from memory")).toBe(true)
    expect(turn.steps.find((step) => step.id === "stored-answer-1")?.detail).toBe("Record #3. The next turn's memory can read it.")
    // Nothing of the tries is stored: the same turn drawn from its records alone shows none of them.
    const records = viewOf(heard.filter((trace) => trace._tag === "Event").reduce((all, trace, index) => record(all, trace, index), emptyBoard(heard.find((trace) => trace._tag === "Prompt")?.session ?? "")), 1)
    expect(records.calls.map((call) => call.attempts)).toEqual([[]])
    expect(records.steps.some((step) => step.kind === "attempt")).toBe(false)
  })

  test("the status line says each attempt that failed and each later one, from the live events; a call answered at once leaves it as the program set it", async () => {
    const { say, attempts } = await page()
    await say("Hello.", "Hello.")
    expect(attempts().flatMap((one) => Option.toArray(attemptLine(one)))).toEqual([
      "attempt 1 failed",
      "attempt 2 on step 1",
    ])
    // The second message: one attempt, which says nothing on the status line.
    expect(attempts().slice(4).map((one) => `${one.outcome} ${one.attempt}`)).toEqual(["started 1", "succeeded 1"])
  })

  test("the list holds one entry per call of the model picked: once it is used up, the model answers as it does", async () => {
    const { say, prompts, failures } = await page()
    await say("Hello.", "Hello.")
    expect(prompts()).toEqual(["echo 1", "echo 1", "echo 2"])
    expect(failures()).toEqual([RETRYABLE])
  })

  test("a call made to fail never reaches the model: the model picked is called only for the calls the list does not make fail", async () => {
    let calls = 0
    const model = makeBrowserModel("counted", {
      generateText: () => Effect.die("this model only streams"),
      streamText: () => {
        calls++
        return Stream.make({ type: "text-delta" as const, id: "t", delta: "Fine." }, { type: "finish" as const, reason: "stop" as const, usage: USAGE })
      },
    }, "native")
    const { say, prompts, replies } = await page(SOURCES, { choice: { ...echoChoice, id: "counted" }, model, interrupt: () => {}, dispose: () => {} })
    await say("Hello.")
    expect(prompts()).toEqual(["counted 1", "counted 1"])
    expect(replies()).toEqual(["Fine."])
    expect(calls).toBe(1)
  })

  test("the list takes one entry each time the model picked is asked: a call tried again takes one for each try", async () => {
    const { say, prompts, failures, replies, view } = await page({ ...SOURCES, failures: "[{ retryable: true }, { retryable: true }]" })
    await say("Hello.")
    expect(prompts()).toEqual(["echo 1", "echo 1", "echo 1"])
    expect(failures()).toEqual([RETRYABLE, RETRYABLE])
    expect(replies()).toEqual([HELLO])
    expect(view(1).calls.map((call) => call.attempts.length)).toEqual([3])
  })

  test("each call of a turn is planned anew, so a turn with a tool call may wait through retries twice", async () => {
    // A model of the test's own that fails each call's first try, worth another try: its first call asks for the
    // calculator, its second answers.
    let tries = 0
    const busy = Stream.fail(AiError.make({ module: "flaky", method: "streamText", reason: new AiError.InternalProviderError({ description: "busy" }) }))
    const model = makeBrowserModel("flaky", {
      generateText: () => Effect.die("this model only streams"),
      streamText: () => {
        tries++
        if (tries === 1 || tries === 3) return busy
        return tries === 2
          ? Stream.make({ type: "tool-call" as const, id: "call-1", name: "calculator", params: { a: 12, op: "*", b: 3 } }, { type: "finish" as const, reason: "tool-calls" as const, usage: USAGE })
          : Stream.make({ type: "text-delta" as const, id: "t", delta: "It is 36." }, { type: "finish" as const, reason: "stop" as const, usage: USAGE })
      },
    }, "native")
    const { say, prompts, replies, view } = await page({ ...SOURCES, failures: "[]" }, { choice: { ...echoChoice, id: "flaky" }, model, interrupt: () => {}, dispose: () => {} })
    const started = performance.now()
    await say("What is 12 * 3?")
    // Two waits of a second: one in each call.
    expect(performance.now() - started).toBeGreaterThanOrEqual(2_000)
    expect(prompts()).toEqual(["flaky 1", "flaky 1", "flaky 1", "flaky 1"])
    expect(replies()).toEqual(["It is 36."])
    expect(view(1).calls.map((call) => call.attempts.map((one) => Option.isSome(one.failed)))).toEqual([[true, false], [true, false]])
  })

  test("a summarizer's call of the model picked is not counted: the list's entry is left for the next call", async () => {
    // A program of the test's own over the page's parts: a summarizer, watched as the page watches lesson 5's,
    // that asks the model picked, failing as the list says, then a call of the same model.
    const made: Array<string> = []
    const ask = (failing: Layer.Layer<LanguageModel.LanguageModel>) => Stream.runCollect(LanguageModel.streamText({ prompt: "Hi." })).pipe(
      Effect.provide(failing),
      Effect.exit,
      Effect.map((exit) => (Exit.isSuccess(exit) ? "answered" : "failed")),
    )
    const lesson: Lesson = {
      ...modelFailures,
      evaluate: (_sources, parts) => {
        const failing = parts.failing([{}])
        const summarizer = parts.watchSummarizer(Layer.succeed(Summarizer, Summarizer.of({
          summarize: () => Effect.map(ask(failing), (said) => { made.push(`summarizer: ${said}`); return said }),
        })))
        const program = Effect.gen(function* () {
          yield* (yield* Summarizer).summarize({ earlier: Option.none(), messages: [] })
          made.push(`call: ${yield* ask(failing)}`)
        }).pipe(Effect.provide(summarizer))
        return Result.succeed(program)
      },
    }
    const runtime = await LessonRuntime.create(lesson)
    opened.push(runtime)
    runtime.setModel(loadEcho())
    const heard: Array<Trace> = []
    const ended = new Promise<void>((resolve) => { runtime.onTrace((trace) => { heard.push(trace); if (trace._tag === "Ended") resolve() }) })
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    await ended
    expect(made).toEqual(["summarizer: answered", "call: failed"])
    expect(heard.flatMap((trace) => (trace._tag === "PromptFailed" ? [trace.purpose ?? "turn"] : []))).toEqual(["turn"])
  })

  test("a turn with a tool call makes two model calls, and the list counts each; the spare's calls are not counted", async () => {
    // Two failures for good: the first fails the turn's first call, which goes to the spare. Were the spare's call
    // counted, the second entry would be spent on it, and the model picked would answer the second call itself.
    const { say, prompts, failures, replies, answeredBy, view, rows } = await page({ ...SOURCES, failures: "[{}, {}]" })
    await say("What is 12 * 3?")
    expect(prompts()).toEqual(["echo 1", "echo-spare 1", "echo 1", "echo-spare 1"])
    expect(failures()).toEqual([FOR_GOOD, FOR_GOOD])
    // The spare asked for the calculator, and answered after its result.
    expect(rows()).toEqual(["user: What is 12 * 3?", "agent: Let me work that out.", 'tool: calculator({"a":12,"op":"*","b":3}) → 36', "agent: The tool answered: calculator says 36."])
    expect(replies()).toEqual(["The tool answered: calculator says 36."])
    expect(await answeredBy()).toEqual(["echo-spare", "echo-spare"])
    // Each model call is planned anew: each starts at the plan's first step.
    expect(view(1).calls.map((call) => call.attempts.map((one) => one.model))).toEqual([["echo", "echo-spare"], ["echo", "echo-spare"]])
  })

  test("the list starts again whenever the program is built: Rebuild, Stop, Clear context and a model picked each make the next call fail again", async () => {
    for (const how of ["rebuild", "stop", "clear", "model"] as const) {
      const { runtime, say, failures } = await page()
      await say("Hello.", "Hello.")
      expect({ how, failures: failures().length }).toEqual({ how, failures: 1 })
      if (how === "rebuild") expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
      if (how === "stop") expect((await runtime.stop()).result).toEqual({ _tag: "Built" })
      if (how === "clear") expect(await runtime.clear()).toEqual({ _tag: "Built" })
      if (how === "model") {
        // As the page does on a model change: the model is set, and the program built again with it.
        runtime.setModel(loadEcho())
        expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
      }
      await say("Hello.")
      expect({ how, failures: failures().length }).toEqual({ how, failures: 2 })
    }
  })

  test("Stop during the wait between attempts ends the turn at once: interrupted, and the model is not asked again", async () => {
    const { runtime, send, until, prompts, outcomes, rows } = await page()
    const failed = until((trace) => trace._tag === "PromptFailed")
    send("Hello.")
    await failed
    // Stopped while the plan waits its second: past that second the model was still asked only once.
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(prompts()).toEqual(["echo 1"])
    expect(await outcomes()).toEqual(["Interrupted"])
    expect(rows()).toEqual(["user: Hello.", "note: Turn 1 was stopped. Your message stays in the journal."])
  })

  test("fails-once: the starter list put back, and the program built again, so the next message fails once and is answered on the second try", async () => {
    const { runtime, say, prompts, failures, replies } = await page()
    await say("Hello.")
    expect(applied("fails-once").failures).toBe("[{ retryable: true }]")
    expect(await runtime.start(applied("fails-once"))).toEqual({ _tag: "Built" })
    await say("Hello.")
    expect(prompts()).toEqual(["echo 1", "echo 1", "echo 2", "echo 2"])
    expect(failures()).toEqual([RETRYABLE, RETRYABLE])
    expect(replies()).toEqual([HELLO, HELLO])
  })

  test("down: a failure not worth another try goes to the spare at once; the record names echo-spare, and the model picked was asked once", async () => {
    const { say, prompts, failures, said, replies, answeredBy, view, heard, runtime } = await page(applied("down"))
    // No wait: retryable refused the failure, so the step gave up at once. A step waits its schedule only before a
    // try of its own again, and there was none: the failed prompt is followed by the spare's, on the plan's next step.
    const order: Array<string> = []
    runtime.onTrace((trace) => { if (trace._tag === "PromptFailed" || trace._tag === "Prompt") order.push(trace._tag === "Prompt" ? `prompt ${trace.model}` : "failed") })
    await say("Hello.")
    expect(order).toEqual(["prompt echo", "failed", `prompt ${SPARE}`])
    expect(prompts()).toEqual(["echo 1", "echo-spare 1"])
    expect(failures()).toEqual([FOR_GOOD])
    expect(said()).toEqual(["started 0.1", "failed 0.1", "started 1.2", "succeeded 1.2"])
    expect(replies()).toEqual([HELLO])
    expect(await answeredBy()).toEqual(["echo-spare"])
    // The spare is watched as the model picked is: its prompt and its usage are traced, under its name.
    expect(heard.flatMap((trace) => (trace._tag === "Prompt" ? [[trace.model, trace.picked]] : []))).toEqual([["echo", "echo"], ["echo-spare", "echo"]])
    expect(heard.filter((trace) => trace._tag === "Usage")).toHaveLength(1)
    // The Context tab names the model that answered, since it is not the one picked.
    const turn = view(1)
    expect(turn.calls.map((call) => Option.getOrNull(call.answeredBy))).toEqual(["echo-spare"])
    expect(turn.steps.find((step) => step.id === "stored-answer-1")?.detail).toBe("Record #3, answered by echo-spare. The next turn's memory can read it.")
    expect(turn.steps.find((step) => step.id === "prompt-1")?.detail.startsWith("Attempt 2, sent to echo-spare.")).toBe(true)
  })

  test("down, with a message that makes a tool call: the spare makes the call, and the model picked, its list used up, answers the second", async () => {
    const { say, prompts, replies, answeredBy, rows, view } = await page(applied("down"))
    await say("What is 12 * 3?")
    expect(prompts()).toEqual(["echo 1", "echo-spare 1", "echo 1"])
    expect(replies()).toEqual(["The tool answered: calculator says 36."])
    expect(await answeredBy()).toEqual(["echo-spare", "echo"])
    expect(rows()).toEqual(["user: What is 12 * 3?", "agent: Let me work that out.", 'tool: calculator({"a":12,"op":"*","b":3}) → 36', "agent: The tool answered: calculator says 36."])
    // The turn's answers name two models, so the Context tab names each.
    expect(view(1).calls.map((call) => Option.getOrNull(call.answeredBy))).toEqual(["echo-spare", "echo"])
  })

  test("cut: one failure after a word; the chat keeps the word and says the answer was cut, the turn fails with AnswerCut, and neither model is asked again", async () => {
    const { say, prompts, failures, said, rows, names, outcomes, journal, view } = await page(applied("cut"))
    await say("Hello.")
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(prompts()).toEqual(["echo 1"])
    expect(failures()).toEqual([CUT])
    expect(said()).toEqual(["started 0.1", "failed 0.1"])
    const reason = `AnswerCut: ${CUT}`
    expect(rows()).toEqual(["user: Hello.", "agent*: Half ", `error: ${failureLine(reason)}`])
    expect(failureLine(reason)).toBe(`The answer was cut: it failed after its first words were shown, and it is not made again. ${CUT}`)
    // modelAnswer stored nothing of the call: the turn holds the message and its failure.
    expect(await names()).toEqual(["core.session.turn.started", "conversation.user.message", "core.session.turn.ended"])
    expect(await outcomes()).toEqual(["Failed"])
    expect((await journal()).flatMap((event) => Option.toArray(dataOf(turnEndedEvent, event))).map((ended) => ended.outcome)).toEqual([{ _tag: "Failed", reason }])
    // The Context tab: one call, one attempt, its prompt's stream failed, and no answer was stored.
    const turn = view(1)
    expect(turn.calls.map((call) => call.attempts.map((one) => [one.model, Option.getOrNull(one.failed), one.pieces]))).toEqual([[["echo", CUT, 1]]])
    expect(turn.steps.map((step) => [step.label, step.state])).toEqual([
      ["Turn opened", "done"], ["Message stored", "done"], ["Memory built the context", "done"],
      ["Prompt sent", "done"], ["Answer streamed", "done"], ["Answer stored", "skipped"], ["Turn closed", "failed"],
    ])
    expect(turn.steps.find((step) => step.id === "prompt-1")?.detail.endsWith(`Its stream failed, and no attempt came after it: ${CUT}.`)).toBe(true)
  })

  test("the start of an answer is no word: a failure after the answer started and showed no piece is tried again", async () => {
    const { say, prompts, replies } = await page({ ...SOURCES, failures: "[{ retryable: true, pieces: [] }]" })
    await say("Hello.")
    expect(prompts()).toEqual(["echo 1", "echo 1"])
    expect(replies()).toEqual([HELLO])
  })

  test("after a word means after the first content part: an answer that is only a tool call, cut, stores no call and runs nothing", async () => {
    // A model of the test's own: its answer asks for the calculator, then fails, worth another try.
    let calls = 0
    const model = makeBrowserModel("calls-then-fails", {
      generateText: () => Effect.die("this model only streams"),
      streamText: () => {
        calls++
        return Stream.concat(
          Stream.make({ type: "tool-call" as const, id: "call-1", name: "calculator", params: { a: 2, op: "+", b: 3 } }),
          Stream.fail(AiError.make({ module: "calls-then-fails", method: "streamText", reason: new AiError.InternalProviderError({ description: "busy" }) })),
        )
      },
    }, "native")
    const loaded: LoadedModel = { choice: { ...echoChoice, id: "calls-then-fails" }, model, interrupt: () => {}, dispose: () => {} }
    const { say, names, outcomes } = await page({ ...SOURCES, failures: "[]" }, loaded)
    await say("What is 2 + 3?")
    expect(calls).toBe(1)
    expect(await names()).toEqual(["core.session.turn.started", "conversation.user.message", "core.session.turn.ended"])
    expect(await outcomes()).toEqual(["Failed"])
  })

  test("what is worth another try: a rate limit is tried again after the plan's second, its own wait not read; an error the model reports in its stream is not, and goes to the spare; a page model's own failure is an unknown error", async () => {
    /** A model of the test's own, whose first call does `first` and whose later calls answer. */
    const modelOf = (name: string, first: () => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>): LoadedModel => {
      let calls = 0
      const model = makeBrowserModel(name, {
        generateText: () => Effect.die("this model only streams"),
        streamText: () => (++calls === 1 ? first() : Stream.make({ type: "text-delta" as const, id: "t", delta: "Fine." }, { type: "finish" as const, reason: "stop" as const, usage: USAGE })),
      }, "native")
      return { choice: { ...echoChoice, id: name }, model, interrupt: () => {}, dispose: () => {} }
    }
    // A rate limit that asks for a wait of a minute: the plan waits its own second, and the same model answers.
    const limited = modelOf("limited", () => Stream.fail(AiError.make({ module: "limited", method: "streamText", reason: new AiError.RateLimitError({ retryAfter: Duration.minutes(1) }) })))
    const rate = await page({ ...SOURCES, failures: "[]" }, limited)
    const started = performance.now()
    await rate.say("Hello.")
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(rate.prompts()).toEqual(["limited 1", "limited 1"])
    expect(rate.replies()).toEqual(["Fine."])
    // An error the model reports inside its stream, before any word: the attempt fails, retryable refuses it, and the
    // spare answers at once. The page marks the prompt failed from the error part.
    const reports = modelOf("reports", () => Stream.make({ type: "text-start" as const, id: "t" }, { type: "error" as const, error: "overloaded" }))
    const reported = await page({ ...SOURCES, failures: "[]" }, reports)
    await reported.say("Hello.")
    expect(reported.prompts()).toEqual(["reports 1", "echo-spare 1"])
    expect(reported.failures()).toEqual(["overloaded"])
    expect(reported.said()).toEqual(["started 0.1", "failed 0.1", "started 1.2", "succeeded 1.2"])
    expect(await reported.answeredBy()).toEqual(["echo-spare"])
    // A rate limit, a provider's own error and a lost connection are worth another try; an unknown error, a refused
    // request, and anything that is no model error, are not.
    const of = (reason: AiError.AiErrorReason) => AiError.make({ module: "m", method: "streamText", reason })
    expect([
      retryable(of(new AiError.RateLimitError({}))), retryable(of(new AiError.InternalProviderError({ description: "x" }))), retryable(of(new AiError.NetworkError({ reason: "TransportError", request: { method: "POST", url: "https://example.com", urlParams: [], headers: {} } }))),
      retryable(of(new AiError.UnknownError({ description: "x" }))), retryable(of(new AiError.InvalidRequestError({ description: "x" }))), retryable(new Error("x")),
    ]).toEqual([true, true, true, false, false, false])
    // The models that run in the page fail with an unknown error: retryable refuses it, so the spare takes the call.
    expect(retryable(aiError("webllm", "streamText", new Error("Device was lost")))).toBe(false)
    expect(retryable(AiError.make({ module: "echo", method: "streamText", reason: new AiError.InternalProviderError({ description: madeFailureWords({ retryable: true }) }) }))).toBe(true)
  })

  test("an experiment of failures.ts pressed over plan-alone's agent.ts, without Reset, runs on that agent.ts: cut makes the answer twice", async () => {
    const sources = applied("cut", applied("plan-alone"))
    expect(sources.agent).toContain("}).pipe(Stream.withExecutionPlan(plan)),")
    const { say, replies } = await page(sources)
    await say("Hello.")
    expect(replies()).toEqual([`Half ${HELLO}`])
  })

  test("plan-alone: Effect's plan without planned tries the call again after a word; the chat shows the word, then the whole next answer, and modelAnswer stores both as one text", async () => {
    const sources = applied("plan-alone")
    expect(sources.agent).toContain("}).pipe(Stream.withExecutionPlan(plan)),")
    expect(sources.failures).toBe('[{ retryable: true, pieces: ["Half "] }]')
    const { say, prompts, failures, said, replies, rows, journal, view } = await page(sources)
    const started = performance.now()
    await say("Hello.")
    // The next try comes after the step's second.
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(prompts()).toEqual(["echo 1", "echo 1"])
    expect(failures()).toEqual([CUT])
    // Effect's plan says nothing about the turn: the attempts are said by planned alone.
    expect(said()).toEqual([])
    expect(replies()).toEqual([`Half ${HELLO}`])
    expect(rows()).toEqual(["user: Hello.", `agent: Half ${HELLO}`])
    // The answer was made twice, and stored as one: the cut first attempt's word, then the second attempt's answer.
    expect((await journal()).flatMap((event) => (event.message?._tag === "Assistant" ? [event.message.text] : []))).toEqual([`Half ${HELLO}`])
    // The Context tab still pairs it: the page's mark of the failed stream, not the live events, groups the attempts.
    expect(view(1).calls.map((call) => call.attempts.map((one) => [one.attempt, one.pieces, Option.isSome(one.failed)]))).toEqual([[[1, 1, true], [2, 22, false]]])
  })

  test("no-while: a step without while tries every failure again; three failures for good are three attempts on the model picked, then the spare answers", async () => {
    const sources = applied("no-while")
    expect(sources.agent).not.toContain("while: retryable")
    expect(sources.failures).toBe("[{}, {}, {}]")
    const { say, prompts, failures, said, replies, answeredBy } = await page(sources)
    const started = performance.now()
    await say("Hello.")
    // Two waits of a second, between the three tries.
    expect(performance.now() - started).toBeGreaterThanOrEqual(2_000)
    expect(prompts()).toEqual(["echo 1", "echo 1", "echo 1", "echo-spare 1"])
    expect(failures()).toEqual([FOR_GOOD, FOR_GOOD, FOR_GOOD])
    expect(said()).toEqual(["started 0.1", "failed 0.1", "started 0.2", "failed 0.2", "started 0.3", "failed 0.3", "started 1.4", "succeeded 1.4"])
    expect(replies()).toEqual([HELLO])
    expect(await answeredBy()).toEqual(["echo-spare"])
  })

  test("the chat drawn again from the journal shows the same stored rows: a retried call and a call the spare answered leave what an answer at once leaves", async () => {
    const { runtime, say, board } = await page()
    await say("Hello.")
    expect(await runtime.start(applied("down"))).toEqual({ _tag: "Built" })
    await say("What is 12 * 3?")
    const stored = board().rows.filter((row) => row.seq !== undefined).map(told)
    expect(chatRowsOf(await runtime.journal()).map(told)).toEqual(stored)
    expect(stored).toEqual(["user: Hello.", `agent: ${HELLO}`, "user: What is 12 * 3?", "agent: Let me work that out.", 'tool: calculator({"a":12,"op":"*","b":3}) → 36', "agent: The tool answered: calculator says 36."])
  })

  test("a cut answer drawn again from the journal: the failure's row says the same, and the word shown live is gone, since it was never stored", async () => {
    const { runtime, say, rows } = await page(applied("cut"))
    await say("Hello.")
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rows().at(-1)).toBe(`error: ${failureLine(`AnswerCut: ${CUT}`)}`)
    expect(chatRowsOf(await runtime.journal()).map(told)).toEqual(["user: Hello.", `error: ${failureLine(`AnswerCut: ${CUT}`)}`])
  })

  test("the page runs untyped code: a plan whose steps provide no model builds, and the first message stops the program, a defect no step tries again", async () => {
    const agent = SOURCES.agent!.replace("    provide: model,\n", "").replace("  { provide: spare },\n", "  { attempts: 1 },\n")
    expect(agent).not.toBe(SOURCES.agent)
    const { result, say, prompts, said, rows } = await page({ ...SOURCES, agent })
    expect(result).toEqual({ _tag: "Built" })
    await say("Hello.")
    // The plan's first step was tried once and failed with a defect: no model was asked, and the spare's step was not tried.
    expect(prompts()).toEqual([])
    expect(said()).toEqual(["started 0.1", "failed 0.1"])
    // The engine's own words for the TypeError follow; the page's are pinned.
    expect(rows().slice(0, 2)).toEqual(["user: Hello.", "error: defect"])
    expect(rows()[2]?.startsWith("error*: Your program stopped: your code threw a TypeError while the agent was built: ")).toBe(true)
  })

  test("the page runs untyped code: a plan whose step provides a part that is no model builds, and the first message stops the program: nothing provides the model, and no step tries again", async () => {
    const agent = SOURCES.agent!.replace("    provide: model,\n", "    provide: toolsLive,\n")
    expect(agent).not.toBe(SOURCES.agent)
    const { say, prompts, said, rows } = await page({ ...SOURCES, agent })
    await say("Hello.")
    expect(prompts()).toEqual([])
    expect(said()).toEqual(["started 0.1", "failed 0.1"])
    expect(rows().at(-1)).toBe("error*: Your program stopped: nothing in the stack provides LanguageModel, and a part above it needs it (Service not found: effect/ai/LanguageModel). Fix your code, then press Rebuild.")
  })

  test("the page runs untyped code: the call without planned(plan), while main provides no model, builds, and the first message stops the program: nothing provides the model", async () => {
    const agent = SOURCES.agent!.replace("          }).pipe(planned(plan)),\n", "          }),\n")
    expect(agent).not.toBe(SOURCES.agent)
    const { result, say, prompts, rows } = await page({ ...SOURCES, agent })
    expect(result).toEqual({ _tag: "Built" })
    await say("Hello.")
    expect(prompts()).toEqual([])
    expect(rows()).toEqual([
      "user: Hello.",
      "error: defect",
      "error*: Your program stopped: nothing in the stack provides LanguageModel, and a part above it needs it (Service not found: effect/ai/LanguageModel). Fix your code, then press Rebuild.",
    ])
  })

  test("the chips and the three: a greeting, a sum and a note, and three messages one turn answers together", async () => {
    expect(modelFailures.chips).toEqual(["Hello.", "What is 12 * 3?", "Remember to buy milk.", "What are my notes?"])
    const { runtime, until, replies, prompts, failures } = await page({ ...SOURCES, failures: "[]" })
    const done = until((trace) => trace._tag === "Reply")
    modelFailures.three.forEach((text) => runtime.send(text))
    await done
    // One turn: three calls in one step, then one answer.
    expect(prompts()).toEqual(["echo 1", "echo 1"])
    expect(failures()).toEqual([])
    expect(replies()).toHaveLength(1)
  })
})
