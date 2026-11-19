import { describe, expect, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { Cause, Effect, ExecutionPlan, Layer, Metric, Redacted } from "effect"
import { LanguageModel, Prompt, Toolkit } from "effect/ai"
import { kernel, modelSpendMemory, Sessions, userMessage } from "@xandreed/core"
import { callTool, fileHandlers, fileTools, flatMemory, inProcessJournal, Memory, modelAnswer, planned, retryable, sessions, shellHandlers, shellTools } from "../index.js"
import { diskFiles, flushTelemetry, openAiCompatibleModel, otlpTelemetry, processShell } from "./index.js"
import { scratch } from "./testing.js"

/*
 * What leaves the process while content is off: a host's turn with a model under a plan, a disk and a shell, run
 * once as it goes well and once as the model refuses the request with the request echoed in its answer (providers
 * do), with a marker planted in every place a conversation's words can come from. Every byte posted to the
 * collector, traces and metrics, is searched for each marker.
 */

const MARK = {
  system: "MARKSYSTEM1e2",
  user: "MARKUSER7f3",
  reply: "MARKREPLY9a1",
  file: "MARKFILE2b8",
  missing: "MARKMISSING4a7",
  command: "MARKCOMMAND5c4",
  tool: "MARKTOOL3d9",
  key: "MARKKEY0d6",
  refusal: "MARKREFUSAL8f8",
  log: "MARKLOG6b5",
  logged: "MARKLOGGED2c1",
} as const

const sse = (chunks: ReadonlyArray<unknown>) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
const usage = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }
const calls = (id: string, name: string, args: unknown) => sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] },
  usage,
])
const ANSWERS = [
  calls("c1", MARK.tool, { anything: true }),
  calls("c2", "writeFile", { path: "notes.txt", text: MARK.file }),
  calls("c3", "readFile", { path: `${MARK.missing}.txt` }),
  calls("c4", "runCommand", { command: `echo ${MARK.command}` }),
  sse([{ choices: [{ delta: { content: `Done ${MARK.reply}` }, finish_reason: "stop" }] }, usage]),
]

/** One turn under the export, the model answering `ANSWERS` in turn, or refusing every request with it echoed. */
const exported = (refuses: boolean, content: boolean) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const posts: Array<string> = []
  const collector = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => { posts.push(await request.text()); return Response.json({}) } })
  let answered = 0
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.text()
    return refuses
      ? new Response(JSON.stringify({ error: { message: `bad request ${MARK.refusal}: ${body}` } }), { status: 400, headers: { "content-type": "application/json" } })
      : new Response(ANSWERS[Math.min(answered++, ANSWERS.length - 1)], { headers: { "content-type": "text/event-stream" } })
  } })
  yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all([collector.stop(true), model.stop(true)])))
  const folder = yield* Effect.flatMap(scratch, (directory) => Effect.promise(() => realpath(directory)))
  const tools = Toolkit.merge(fileTools, shellTools)
  const provider = openAiCompatibleModel({
    model: "m", baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: Redacted.make(MARK.key), maxOutputTokens: 50, spend: { prices: { m: { input: 1, output: 1 } } },
  })
  const plan = ExecutionPlan.make({ provide: provider, attempts: 2, while: retryable })
  const stack = flatMemory.pipe(
    Layer.provideMerge(sessions()), Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()),
    Layer.provideMerge(Layer.merge(fileHandlers, shellHandlers)),
    Layer.provideMerge(Layer.merge(diskFiles({ root: folder }), processShell({ cwd: folder }))),
    Layer.provideMerge(modelSpendMemory),
  )
  const program = Effect.gen(function* () {
    const all = yield* Sessions
    const memory = yield* Memory
    const toolkit = yield* tools
    const id = yield* all.create({ owner: "host" })
    return yield* all.turn(id, (session) => Effect.gen(function* () {
      yield* session.append(userMessage(`Please ${MARK.user}`))
      // A host's own logs inside the turn: one whose words hold a marker, one with a cause that does.
      yield* Effect.logWarning(`the host noted ${MARK.log}`)
      yield* Effect.logError("the host saw a failure", Cause.fail(new Error(MARK.logged)))
      for (let step = 0; step < 6; step++) {
        const history = yield* memory.context(session)
        const answer = yield* modelAnswer(LanguageModel.streamText({
          prompt: Prompt.make([{ role: "system", content: MARK.system }, ...history]), toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred",
        }).pipe(planned(plan)), session)
        if (answer.toolCalls.length === 0) return answer.text
        for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
      }
      return "stopped"
    }))
  })
  const exit = yield* program.pipe(
    Effect.provide(stack),
    Effect.exit,
    Effect.tap(() => flushTelemetry),
    Effect.provide(otlpTelemetry({ baseUrl: `http://127.0.0.1:${collector.port}`, protocol: "http/json", exportInterval: "1 hour", content })),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  )
  return { exit, posted: posts.join("\n") }
})))

const found = (posted: string) => Object.entries(MARK).filter(([, marker]) => posted.includes(marker)).map(([name]) => name)

describe("with content off, no word of the conversation leaves the process", () => {
  test("a turn that goes well: the system text, the messages, a tool's text, command and unknown name, a missing path, the key and the host's logs stay in", async () => {
    const run = await exported(false, false)
    expect(run.exit._tag).toBe("Success")
    // What was searched holds both signals: the traces and the metrics, the counts of the calls among them.
    for (const part of ["resourceSpans", "resourceMetrics", "efferent.model.calls", "efferent.model.tokens", "efferent.model.cost", "efferent.tool.calls"]) expect(run.posted).toContain(part)
    expect(found(run.posted)).toEqual([])
  }, 30_000)

  test("a model that refuses the request and echoes it back: the failure's words reach no span's status, exception or attempt event", async () => {
    const run = await exported(true, false)
    expect(run.exit._tag).toBe("Failure")
    for (const part of ["resourceSpans", "resourceMetrics", "\"exception\"", "model.attempt", "efferent.model.calls", "\"refused\""]) expect(run.posted).toContain(part)
    expect(found(run.posted)).toEqual([])
  }, 30_000)

  // The control: each marker the tests above look for does reach a span when the host asks for content.
  test("with content on, the export keeps what was said: every marker of a turn that goes well, and a failure's words", async () => {
    const well = await exported(false, true)
    expect(found(well.posted).toSorted()).toEqual(["command", "file", "log", "logged", "missing", "reply", "system", "tool", "user"])
    const refused = await exported(true, true)
    expect(found(refused.posted)).toEqual(expect.arrayContaining(["system", "user", "refusal", "log", "logged"]))
  }, 30_000)
})
