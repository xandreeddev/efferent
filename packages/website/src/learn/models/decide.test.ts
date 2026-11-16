// The decision client against the answer Jev gave through the gateway on 2026-11-16, a scripted decider, and the
// types: an answer's shape follows from its question's, and a choice's value is one the question listed.
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { AiError } from "effect/ai"
import { decide, gatewayDecider, scriptedDecider } from "./decide.ts"
import type { Answers } from "./decide.ts"
import type { Fetch } from "./gateway.ts"

const questions = [
  { type: "predicate", name: "correct", instructions: "Is the agent's answer to the question correct?" },
  { type: "choice", name: "tone", instructions: "How does the answer read?", choices: [{ value: "plain", description: "short and direct" }, { value: "chatty", description: "long, with small talk" }] },
  { type: "score", name: "helpful", instructions: "How helpful is the answer?", levels: [{ label: "not" }, { label: "somewhat" }, { label: "very" }] },
] as const

/** Jev's answer, as the gateway gave it. */
const jev = {
  answers: [
    { type: "predicate", name: "correct", probability: 0.99 },
    { type: "choice", name: "tone", choice: "plain", confidence: 1, probabilities: [{ value: "plain", probability: 1 }, { value: "chatty", probability: 0 }] },
    { type: "score", name: "helpful", score: 1.95, confidence: 0.92, probabilities: [{ value: 0, label: "not", probability: 0.01 }, { value: 1, label: "somewhat", probability: 0.03 }, { value: 2, label: "very", probability: 0.96 }] },
  ],
  model: "typesafe-ai/jev",
  usage: { input_tokens: 96, output_tokens: 0, total_tokens: 96 },
}
const answering = (status: number, body: unknown) => {
  const sent: Array<{ readonly url: string; readonly headers: Record<string, string>; readonly body: string }> = []
  const fetchFn: Fetch = (url, init) => { sent.push({ url, headers: init.headers, body: init.body }); return Promise.resolve(new Response(JSON.stringify(body), { status })) }
  return { fetchFn, sent }
}

describe("a decision", () => {
  test("each answer comes back by name, typed by its question, from one request to the gateway's decisions", async () => {
    const { fetchFn, sent } = answering(200, jev)
    const answers = await Effect.runPromise(decide(gatewayDecider(() => Option.some("k"), "typesafe-ai/jev", fetchFn), "The user asked: What is 2 + 3? The agent answered: 5.", questions))
    expect(answers.correct.probability).toBe(0.99)
    const tone: "plain" | "chatty" = answers.tone.choice
    expect(tone).toBe("plain")
    expect(answers.helpful.score).toBe(1.95)
    expect(sent.map((one) => one.url)).toEqual(["https://ai-gateway.vercel.sh/v1/decisions"])
    expect(sent[0]!.headers.authorization).toBe("Bearer k")
    expect(JSON.parse(sent[0]!.body)).toEqual({ model: "typesafe-ai/jev", input: "The user asked: What is 2 + 3? The agent answered: 5.", questions })
  })

  test("a refused question, or a choice the question did not list, fails in words", async () => {
    const refused = { ...jev, answers: [jev.answers[0], { type: "refusal", name: "tone" }, jev.answers[2]] }
    const exit = await Effect.runPromiseExit(decide(gatewayDecider(() => Option.some("k"), "typesafe-ai/jev", answering(200, refused).fetchFn), "x", questions))
    expect(JSON.stringify(exit)).toContain("gave no answer to \\\"tone\\\"")
    const unlisted = scriptedDecider((_input, question) => Option.some(question.type === "choice" ? { choice: "rude", confidence: 1, probabilities: [] } : question.type === "predicate" ? { probability: 1 } : jev.answers[2]))
    const second = await Effect.runPromiseExit(decide(unlisted, "x", questions))
    expect(JSON.stringify(second)).toContain("gave no answer to \\\"tone\\\"")
  })

  test("with no key nothing is sent, and a failure of the gateway is the gateway model's", async () => {
    const { fetchFn, sent } = answering(200, jev)
    const none = await Effect.runPromiseExit(decide(gatewayDecider(() => Option.none(), "typesafe-ai/jev", fetchFn), "x", questions))
    expect(none._tag).toBe("Failure")
    expect(sent).toEqual([])
    const busy = await Effect.runPromiseExit(decide(gatewayDecider(() => Option.some("k"), "typesafe-ai/jev", answering(429, { error: {} }).fetchFn), "x", questions))
    const error = busy._tag === "Failure" ? busy.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
    expect(error !== undefined && error._tag === "Fail" && AiError.isAiError(error.error) ? [error.error.reason._tag, error.error.isRetryable] : []).toEqual(["RateLimitError", true])
  })

  test("a scripted decider answers by its rule, and sends nothing", async () => {
    const yes = scriptedDecider((input, question) => (question.type === "predicate" ? Option.some({ probability: input.includes("5") ? 1 : 0 }) : Option.none()))
    const answers = await Effect.runPromise(decide(yes, "The agent answered: 5.", [questions[0]]))
    expect(answers.correct.probability).toBe(1)
  })

  test("type-level: a choice's answer has the question's values, a predicate's has no choice", () => {
    const check = (answers: Answers<typeof questions>) => {
      // @ts-expect-error "rude" is not one of the values the question listed.
      const wrong: typeof answers.tone.choice = "rude"
      // @ts-expect-error a predicate's answer is a probability alone.
      void answers.correct.choice
      return wrong
    }
    expect(typeof check).toBe("function")
  })
})
