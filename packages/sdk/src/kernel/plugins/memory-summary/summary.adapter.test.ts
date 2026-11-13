import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Option, Ref } from "effect"
import type { Message } from "@xandreed/core/kernel"
import { messageText, summarizedEvent, Summarizer, SummaryFailed, summaryMemory } from "../../index.js"
import type { SummaryOptions } from "../../index.js"
import { answering, open, stack } from "../../testing.js"
import type { Received } from "../../testing.js"
import { summaryNote } from "./summary.entity.functions.js"

/*
 * The summary memory over the tests' turn. Each message is 4 tokens
 * ("Message number 1") and each answer 7 ("An answer of some length."), so
 * a closed turn costs 11, and the note's frame alone 15.
 */

/** What the summarizer was asked, call by call. */
type Asked = ReadonlyArray<{ readonly earlier: Option.Option<string>; readonly messages: ReadonlyArray<string> }>

const run = (options: SummaryOptions, turns: number, summaryOf: (call: number) => Effect.Effect<string, SummaryFailed> = (call) => Effect.succeed(`Summary ${call + 1}.`)) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { model, received } = yield* answering("An answer of some length.")
    const asked = yield* Ref.make<Asked>([])
    const summarizer = Layer.succeed(Summarizer, Summarizer.of({
      summarize: ({ earlier, messages }) => Effect.flatMap(
        Ref.modify(asked, (all) => [all.length, [...all, { earlier, messages: messages.map((message: Message) => messageText(message)) }]] as const),
        summaryOf,
      ),
    }))
    const agent = yield* open(stack(model, { memory: Layer.provide(summaryMemory(options), summarizer) }))
    const session = yield* agent.createSession({ owner: "learner" })
    const exits = yield* Effect.forEach(Array.from({ length: turns }), (_, index) => Effect.exit(agent.send(session, `Message number ${index + 1}`)), { concurrency: 1 })
    const journal = (yield* agent.inspect(session)).events
    return { exits, asked: yield* Ref.get(asked), prompts: yield* received, summaries: journal.filter((event) => event.name === summarizedEvent.name) }
  })).pipe(Effect.timeout("5 seconds")))

/** The messages of a prompt after the system text, as role and text. */
const contextOf = (prompt: Received[number]) => prompt.slice(1).map((message) => `${message.role} ${message.text}`)

describe("the summary memory", () => {
  test("sends the summary as a host note whose words are fixed", () => {
    expect(summaryNote("You asked about fibers.")).toBe("[Host note: earlier turns of this conversation, in short: You asked about fibers.]")
  })

  test("while the conversation fits, sends every message, asks for no summary and stores none", async () => {
    const { prompts, asked, summaries } = await run({ budgetTokens: 60 }, 6)
    expect(prompts.map((prompt) => prompt.length - 1)).toEqual([1, 3, 5, 7, 9, 11])
    expect(asked).toEqual([])
    expect(summaries).toEqual([])
  })

  test("over the budget, folds the oldest whole turns into one summary, stored once, and keeps the latest turn whole", async () => {
    const { prompts, asked, summaries } = await run({ budgetTokens: 60 }, 7)
    // Six closed turns (66) and the open one (4) are over 60: three turns fold, beside the frame (15), so 15 + 33 + 4 fits.
    expect(asked).toEqual([{
      earlier: Option.none(),
      messages: [1, 2, 3].flatMap((n) => [`Message number ${n}`, "An answer of some length."]),
    }])
    expect(summaries.map((event) => [event.tags.map(String), event.message])).toEqual([[["memory"], { _tag: "User", text: summaryNote("Summary 1.") }]])
    expect(contextOf(prompts[6]!)).toEqual([
      `user ${summaryNote("Summary 1.")}`,
      ...[4, 5, 6].flatMap((n) => [`user Message number ${n}`, "assistant An answer of some length."]),
      "user Message number 7",
    ])
  })

  test("after a compaction, every context starts with the one before until the next, which folds the summary so far", async () => {
    const { prompts, asked, summaries } = await run({ budgetTokens: 70 }, 12)
    expect(summaries.length).toBe(asked.length)
    expect(asked.length).toBeGreaterThan(1)
    expect(asked[1]!.earlier).toEqual(Option.some("Summary 1."))
    const contexts = prompts.map(contextOf)
    const compactedAt = contexts.flatMap((context, index) => index > 0 && context[0] !== contexts[index - 1]![0] ? [index] : [])
    expect(compactedAt.length).toBe(asked.length)
    contexts.forEach((context, index) => {
      if (index === 0 || compactedAt.includes(index)) return
      expect(context.slice(0, contexts[index - 1]!.length)).toEqual(contexts[index - 1]!)
    })
  })

  test("a summary still over the budget fails the context with OverBudget, after one summary and never a second", async () => {
    const { exits, asked } = await run({ budgetTokens: 60 }, 7, () => Effect.succeed("long ".repeat(200)))
    expect(asked.length).toBe(1)
    const last = exits.at(-1)!
    expect(Exit.isFailure(last) && Exit.findErrorOption(last).pipe(Option.map((error) => error._tag), Option.getOrNull)).toBe("OverBudget")
  })

  test("a summarizer that fails fails the context with its error, and stores no summary", async () => {
    const { exits, summaries } = await run({ budgetTokens: 60 }, 7, () => Effect.fail(new SummaryFailed({ message: "the summarizer is down" })))
    const last = exits.at(-1)!
    expect(Exit.isFailure(last) && Exit.findErrorOption(last).pipe(Option.map((error) => error._tag), Option.getOrNull)).toBe("SummaryFailed")
    expect(summaries).toEqual([])
  })
})
