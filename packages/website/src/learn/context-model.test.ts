import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { DEFAULT_CONFIG } from "./lesson1.source.ts"
import { loadEcho } from "./models/mock.ts"
import { allocate, inspectorOf, journalOf } from "./context-model.ts"
import type { JournalEvent, ReportRow } from "./context-model.ts"
import type { CapturedRequest } from "./capture.ts"
import { DEFAULT_TINY } from "./tiny-memory.source.ts"
import { LessonRuntime } from "./runtime.ts"

const ev = (seq: number, kind: string, turn: number, data: unknown): JournalEvent => ({ seq, kind, turn: Option.some(turn), data })
const started = (seq: number, turn: number, text: string) => ev(seq, "turn.started", turn, { userMessage: { text } })
const replied = (seq: number, turn: number, text: string) => ev(seq, "memory.message", turn, { body: { message: { role: "assistant", content: [{ type: "text", text }] } } })
const dropped = (seq: number, turn: number, through: number) => ev(seq, "memory.compaction", turn, { body: { action: { _tag: "DropTurns", throughTurn: through, ledger: "x" } } })

describe("allocate", () => {
  test("parts always sum to the total", () => {
    for (const total of [0, 1, 7, 100, 1013]) {
      for (const weights of [[1], [1, 1, 1], [5, 1, 9, 2], [0, 3, 0]]) {
        expect(allocate(total, weights).reduce((a, b) => a + b, 0)).toBe(total)
      }
    }
    expect(allocate(5, [])).toEqual([])
  })
})

describe("journalOf", () => {
  test("reads what you said, what the agent replied, and what was dropped, in order", () => {
    const { entries, drops } = journalOf([started(1, 1, "hi"), replied(2, 1, "hello"), dropped(3, 1, 1), started(4, 2, "again")])
    expect(entries.map((e) => `${e.turn}:${e.role}:${e.text}`)).toEqual(["1:you:hi", "1:agent:hello", "2:you:again"])
    expect(drops).toEqual([{ seq: 3, throughTurn: 1 }])
  })
})

describe("inspectorOf, over a hand-built journal", () => {
  const row = (seq: number, turn: number, estimated: number, budget = 400): ReportRow => ({
    seq, turn, run: 0, step: 0, system: { tokens: 10 }, tools: { tokens: 0 },
    built: Option.some({ estimatedTokens: estimated, reservedTokens: 10, budgetTokens: budget, compactions: 0 }),
  })
  const msg = (role: "system" | "user" | "assistant", text: string, volatile = false) => ({ role, text, volatile })
  const events = [
    started(1, 1, "one"), ev(2, "request.prepared", 1, {}), replied(3, 1, "r1"),
    started(4, 2, "two"), ev(5, "request.prepared", 1, {}), replied(6, 2, "r2"),
    dropped(7, 2, 1),
    started(8, 3, "three"), ev(9, "request.prepared", 3, {}),
  ]
  const captures: Map<string, CapturedRequest> = new Map([
    ["1:0:0", { tools: [], messages: [msg("system", "sys"), msg("user", "one")] }],
    ["2:0:0", { tools: [], messages: [msg("system", "sys"), msg("user", "one"), msg("assistant", "r1"), msg("user", "two")] }],
    ["3:0:0", { tools: [], messages: [msg("system", "sys"), msg("user", "[Host note: earlier turns were condensed to free context.]\n\nEarlier: one"), msg("assistant", "r2x"), msg("user", "three")] }],
  ])
  const model = inspectorOf({ events, rows: [row(2, 1, 20), row(5, 2, 60), row(9, 3, 40)], captures })

  test("layers sum to the report's message tokens plus the reserve", () => {
    for (const request of model.requests) {
      expect(request.layers.reduce((sum, l) => sum + l.tokens, 0)).toBe(request.usedTokens)
    }
  })

  test("the stack names the system prompt, a ledger note and the current message", () => {
    expect(model.requests[2]!.layers.map((l) => l.kind)).toEqual(["system", "ledger", "past", "current"])
  })

  test("an entry is dropped only for requests prepared after the drop was recorded", () => {
    const statusIn = (request: number) => model.requests[request]!.entries.map((e) => `${e.entry.turn}${e.entry.role[0]}:${e.status}`)
    expect(statusIn(1)).toEqual(["1y:shown", "1a:shown", "2y:current", "2a:reply"])
    expect(statusIn(2)).toEqual(["1y:dropped", "1a:dropped", "2y:shown", "2a:shown", "3y:current"])
  })

  test("a request's reply is the agent message journaled after it, and is not counted in its input", () => {
    const first = model.requests[0]!
    expect(Option.map(first.reply, (r) => `${r.turn}:${r.text}`)).toEqual(Option.some("1:r1"))
    expect(first.usedTokens).toBe(first.messageTokens + first.reservedTokens)
    expect(Option.map(model.requests[1]!.reply, (r) => r.turn)).toEqual(Option.some(2))
    // the last turn has not been answered in this journal, so its request has no reply yet
    expect(Option.isNone(model.requests[2]!.reply)).toBe(true)
  })

  test("the reusable prefix is what the previous request already held, and collapses when older turns are rewritten", () => {
    expect(Option.isNone(model.requests[0]!.prefix)).toBe(true)
    expect(model.requests[1]!.layers.map((l) => l.reusable)).toEqual([true, true, false, false])
    expect(model.requests[2]!.layers.map((l) => l.reusable)).toEqual([true, false, false, false])
    const second = Option.getOrThrow(model.requests[1]!.prefix)
    expect(second.layers).toBe(2)
    expect(second.of).toBe(model.requests[1]!.usedTokens)
  })

  test("a volatile message and a changed toolset end the reusable prefix", () => {
    const withTools = new Map(captures)
    withTools.set("2:0:0", { tools: ["lookup"], messages: captures.get("2:0:0")!.messages })
    expect(Option.getOrThrow(inspectorOf({ events, rows: [row(2, 1, 20), row(5, 2, 60)], captures: withTools }).requests[1]!.prefix).layers).toBe(0)
    const volatile = new Map(captures)
    volatile.set("1:0:0", { tools: [], messages: [msg("system", "sys"), msg("user", "one", true)] })
    expect(Option.getOrThrow(inspectorOf({ events, rows: [row(2, 1, 20), row(5, 2, 60)], captures: volatile }).requests[1]!.prefix).layers).toBe(1)
  })

  test("a turn that never got a request is flagged as failed", () => {
    const failed = inspectorOf({
      events: [started(1, 1, "one"), ev(2, "request.prepared", 1, {}), replied(3, 1, "r1"), started(4, 2, "too big"), started(5, 3, "three"), ev(6, "request.prepared", 3, {})],
      rows: [row(2, 1, 20), row(6, 3, 30)],
      captures: new Map([["1:0:0", { tools: [], messages: [msg("system", "s"), msg("user", "one")] }], ["3:0:0", { tools: [], messages: [msg("system", "s"), msg("user", "three")] }]]),
    })
    expect(failed.requests[1]!.entries.map((e) => `${e.entry.text}:${e.status}`)).toEqual(["one:shown", "r1:shown", "too big:shown", "three:current"])
    expect(failed.requests[1]!.entries.map((e) => e.turnFailed)).toEqual([false, false, true, false])
  })

  test("a request that was not captured still reports its tokens, with no layers", () => {
    const none = inspectorOf({ events, rows: [row(2, 1, 20)], captures: new Map() })
    expect(none.requests[0]!.layers).toEqual([])
    expect(none.requests[0]!.usedTokens).toBe(30)
  })
})

describe("inspectorOf, over a real session", () => {
  const talk = async (config: string, tiny: string | undefined, messages: ReadonlyArray<string>) => {
    const runtime = await LessonRuntime.create()
    runtime.setModel(loadEcho())
    await runtime.rebuild(config, tiny)
    for (const text of messages) await runtime.send(text, { onEvent: () => {} }).catch(() => {})
    const { events, report, captures } = await runtime.inspect()
    await runtime.dispose()
    return inspectorOf({ events: events as never, rows: report.rows as never, captures })
  }

  test("a squeezed window drops older turns from the request while the journal keeps them", async () => {
    const model = await talk(DEFAULT_CONFIG.replace("budgetTokens: 3000", "budgetTokens: 400"), undefined,
      ["tell me about topic 1", "tell me about topic 2", "tell me about topic 3", "tell me about topic 4", "tell me about topic 5"])
    const last = model.requests.at(-1)!
    expect(last.layers.some((l) => l.kind === "ledger")).toBe(true)
    expect(last.entries.some((e) => e.status === "dropped")).toBe(true)
    expect(model.journal.filter((e) => e.role === "you").length).toBe(5)
    expect(last.layers.reduce((sum, l) => sum + l.tokens, 0)).toBe(last.usedTokens)
    // The prefix the model could have reused is shorter than the whole stack once the older turns were rewritten.
    const prefix = Option.getOrThrow(last.prefix)
    expect(prefix.tokens).toBeLessThan(prefix.of)
  })

  test("with room to spare, each request extends the one before it", async () => {
    const model = await talk(DEFAULT_CONFIG, undefined, ["tell me about topic 1", "tell me about topic 2", "tell me about topic 3"])
    const prefixes = model.requests.slice(1).map((r) => Option.getOrThrow(r.prefix))
    prefixes.forEach((p) => { expect(p.layers).toBeGreaterThan(1); expect(p.tokens).toBeGreaterThan(0) })
    expect(model.requests.every((r) => !r.over)).toBe(true)
  })

  test("the tiny keep-last plugin bounds the request and the stack says so", async () => {
    const config = DEFAULT_CONFIG.replace("memoryWindowPlugin,", "tinyMemory(2),")
    const model = await talk(config, DEFAULT_TINY, ["tell me about topic 1", "tell me about topic 2", "tell me about topic 3", "tell me about topic 4"])
    // system + current; then the whole chat; then (ledger note + the one turn kept + current) from turn 3 on.
    expect(model.requests.map((r) => r.layers.length)).toEqual([2, 4, 5, 5])
    expect(model.requests.at(-1)!.layers.map((l) => l.kind)).toEqual(["system", "ledger", "past", "past", "current"])
    expect(model.requests.at(-1)!.entries.filter((e) => e.status === "dropped").length).toBe(4)
  })

  /** Every journal label must agree with what the model was actually sent. */
  const agrees = (model: ReturnType<typeof inspectorOf>) => {
    for (const request of model.requests) {
      const sent = new Set(request.layers.map((layer) => layer.text))
      for (const { entry, status } of request.entries) {
        if (status === "shown" || status === "current") expect(sent.has(entry.text)).toBe(true)
        else expect(sent.has(entry.text)).toBe(false)
      }
    }
  }

  test("journal labels agree with the captured request, under a squeezed window and under the tiny plugin", async () => {
    const messages = ["tell me about topic 1", "tell me about topic 2", "tell me about topic 3", "tell me about topic 4", "tell me about topic 5", "tell me about topic 6"]
    agrees(await talk(DEFAULT_CONFIG.replace("budgetTokens: 3000", "budgetTokens: 400"), undefined, messages))
    agrees(await talk(DEFAULT_CONFIG.replace("memoryWindowPlugin,", "tinyMemory(2),"), DEFAULT_TINY, messages))
  }, 60000)

  test("a failed turn's message stays in the journal and later requests carry it, flagged as failed", async () => {
    const runtime = await LessonRuntime.create()
    runtime.setModel(loadEcho())
    await runtime.rebuild(DEFAULT_CONFIG.replace("budgetTokens: 3000", "budgetTokens: 5"))
    const failed = await runtime.send("tell me about topic 1", { onEvent: () => {} }).then(() => false, () => true)
    expect(failed).toBe(true)
    await runtime.rebuild(DEFAULT_CONFIG)
    await runtime.send("tell me about topic 2", { onEvent: () => {} })
    await runtime.send("tell me about topic 3", { onEvent: () => {} })
    const { events, report, captures } = await runtime.inspect()
    await runtime.dispose()
    const model = inspectorOf({ events: events as never, rows: report.rows as never, captures })
    expect(model.requests.length).toBe(2)
    const second = model.requests[1]!
    const failedEntry = second.entries.find((e) => e.entry.text === "tell me about topic 1")!
    expect(failedEntry.turnFailed).toBe(true)
    expect(failedEntry.status).toBe("shown")
    agrees(model)
  }, 30000)

  test("a memory plugin that ignores the budget goes over it, and the stack says so", async () => {
    const config = DEFAULT_CONFIG.replace("memoryWindowPlugin,", "tinyMemory(2),").replace("budgetTokens: 3000", "budgetTokens: 60")
    const model = await talk(config, DEFAULT_TINY, ["tell me about topic 1", "tell me about topic 2", "tell me about topic 3", "tell me about topic 4"])
    expect(model.requests.length).toBe(4)
    expect(model.requests.at(-1)!.over).toBe(true)
    expect(model.requests.at(-1)!.usedTokens).toBeGreaterThan(60)
  }, 30000)
})
