import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Prompt } from "effect/ai"
import { ConversationId, SessionLog, sessionRef, entriesOfEvents } from "@xandreed/core"
import { SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { ReadResult } from "@xandreed/plugin-workspace"
import { runMemoryWalkthrough } from "./memory-walkthrough.js"

const TurnSnapshot = Schema.Struct({
  number: Schema.Int,
  session: Schema.String,
  deploymentFile: Schema.String,
  journalEvents: Schema.Int,
  addedEvents: Schema.Array(Schema.Struct({ seq: Schema.Int, kind: Schema.String })),
  requests: Schema.Array(Schema.Struct({ tools: Schema.Array(Schema.String), prompt: Prompt.Prompt })),
  compactions: Schema.Array(Schema.Struct({
    turn: Schema.Int,
    action: Schema.Struct({ _tag: Schema.String, throughTurn: Schema.optionalKey(Schema.Int) }),
  })),
  context: Schema.Array(Schema.Struct({ estimatedTokens: Schema.Number, reservedTokens: Schema.Number, budgetTokens: Schema.Number })),
  pendingMemoryJobs: Schema.Int,
  learnedFacts: Schema.Array(Schema.String),
})
const ProcessingSnapshot = Schema.Struct({
  checkpoint: Schema.String, processed: Schema.Int,
  learnedFacts: Schema.Array(Schema.String), graphAssertions: Schema.Array(Schema.String),
})
const preference = "The user prefers concise release summaries."
const middle = "Log record 080: normal deployment diagnostic details for service alpha."

test("the walkthrough persists real edits and journal evidence while compacting context and learning across conversations", async () => {
  const output = await mkdtemp(join(tmpdir(), "efferent-memory-walkthrough-test-"))
  try {
    const { root, report } = await Effect.runPromise(Effect.scoped(runMemoryWalkthrough(output)))
    expect(report.note).toContain("Scripted model, extraction and embeddings")
    expect(report.note).toContain("in-memory and retained across agent reopen, not a persistent database")
    const turns = report.snapshots.flatMap((value) => Option.toArray(Schema.decodeUnknownOption(TurnSnapshot)(value)))
    const processing = report.snapshots.flatMap((value) => Option.toArray(Schema.decodeUnknownOption(ProcessingSnapshot)(value)))
    expect(turns.map((turn) => turn.number)).toEqual([1, 2, 3, 4, 5])
    expect(report.snapshots).toHaveLength(turns.length + processing.length)
    expect(processing).toHaveLength(1)
    const turn = (number: number) => {
      const found = turns.find((snapshot) => snapshot.number === number)
      if (found === undefined) throw new Error(`Missing walkthrough turn ${number}`)
      return found
    }
    const first = turn(1), edited = turn(2), spilled = turn(3), reopened = turn(4), fresh = turn(5)
    expect(first.deploymentFile).toContain("lane: green")
    for (const snapshot of [edited, spilled, reopened, fresh]) expect(snapshot.deploymentFile).toBe("lane: blue\nstatus: draft\n")
    expect(await readFile(join(root, "workspace/deployment.md"), "utf8")).toBe("lane: blue\nstatus: draft\n")

    expect(spilled.compactions.some((entry) => entry.action._tag === "Spill")).toBe(true)
    expect(turns.some((snapshot) => snapshot.compactions.some((entry) => entry.action._tag === "CompactViews"))).toBe(true)
    expect(reopened.compactions.some((entry) => entry.action._tag === "DropTurns" && entry.action.throughTurn === 2)).toBe(true)
    const preview = spilled.requests[1]
    if (preview === undefined) throw new Error("The read produced no next model request")
    expect(JSON.stringify(preview.prompt.content)).toContain("call recall_context")
    expect(JSON.stringify(preview.prompt.content)).not.toContain(middle)
    expect(JSON.stringify(preview.prompt.content)).not.toContain("ERROR_AT_END")
    const tailResults = spilled.requests.flatMap((request) => request.prompt.content.flatMap((message) => message.role === "tool"
      ? message.content.filter((part) => part.type === "tool-result" && part.name === "recall_context").map((part) => JSON.stringify(part)) : []))
    expect(tailResults.some((result) => result.includes("ERROR_AT_END: queue worker stopped."))).toBe(true)
    expect(spilled.requests.some((request) => request.prompt.content.some((message) => message.role === "assistant"
      && message.content.some((part) => part.type === "tool-call" && part.name === "recall_context")))).toBe(true)

    const contexts = turns.flatMap((snapshot) => snapshot.context)
    expect(contexts.length).toBeGreaterThan(0)
    expect(contexts.every((context) => context.estimatedTokens <= context.budgetTokens - context.reservedTokens)).toBe(true)
    expect([first, edited, spilled].map((snapshot) => snapshot.pendingMemoryJobs)).toEqual([1, 2, 3])
    expect([first, edited, spilled].every((snapshot) => snapshot.learnedFacts.length === 0)).toBe(true)
    expect(processing[0]).toMatchObject({ processed: 3, learnedFacts: [preference], graphAssertions: [preference] })

    expect(reopened.session).toContain("reopened")
    expect(reopened.addedEvents[0]?.seq).toBe(spilled.journalEvents + 1)
    expect(reopened.journalEvents).toBeGreaterThan(spilled.journalEvents)
    const freshPrompt = fresh.requests[0]?.prompt.content
    if (freshPrompt === undefined) throw new Error("The new conversation produced no model request")
    expect(JSON.stringify(freshPrompt)).toContain("<recalled-memory>")
    expect(JSON.stringify(freshPrompt)).toContain(preference)
    expect(freshPrompt.some((message) => message.role === "assistant" || message.role === "tool")).toBe(false)
    expect(JSON.stringify(freshPrompt)).not.toContain("read-deployment")
    expect(JSON.stringify(freshPrompt)).not.toContain("edit-deployment")
    expect(JSON.stringify(freshPrompt)).not.toContain(middle)
    expect(fresh.journalEvents).toBeLessThan(reopened.journalEvents)

    const journal = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = Context.get(yield* Layer.build(SessionLogFilesLive(join(root, "journal"))), SessionLog)
      const a = yield* service.read(sessionRef(yield* service.head(ConversationId.make("00000000-0000-4000-8000-0000000000a1"))), { after: 0, kinds: [], limit: Option.none() })
      const b = yield* service.read(sessionRef(yield* service.head(ConversationId.make("00000000-0000-4000-8000-0000000000b1"))), { after: 0, kinds: [], limit: Option.none() })
      const entries = yield* entriesOfEvents(a)
      const reads = yield* Effect.forEach(entries.filter((entry) => entry.body._tag === "ToolResult" && entry.body.toolName === "read"), (entry) =>
        entry.body._tag === "ToolResult" ? Schema.decodeUnknownEffect(ReadResult)(entry.body.encoded) : Effect.die("Expected a recorded read result"), { concurrency: 1 })
      return { a, b, reads }
    })))
    expect(journal.a).toHaveLength(reopened.journalEvents)
    expect(journal.b).toHaveLength(fresh.journalEvents)
    expect(await readFile(join(root, "journal-A.json"), "utf8")).toBe(JSON.stringify(journal.a, null, 2))
    expect(await readFile(join(root, "journal-B.json"), "utf8")).toBe(JSON.stringify(journal.b, null, 2))
    const archivedLog = journal.reads.find((result) => result._tag === "Text" && result.path === "build.log")
    if (archivedLog === undefined || archivedLog._tag !== "Text") throw new Error("The raw file journal lost the original log result")
    expect(archivedLog.text).toBe((await readFile(join(root, "workspace/build.log"), "utf8")).trimEnd())
    expect(archivedLog.text).toContain(middle)
    expect(archivedLog.text).toContain("ERROR_AT_END: queue worker stopped.")
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)

test("published walkthrough evidence identifies the current executable source", async () => {
  const metadata = Schema.Struct({ sourceHash: Schema.String })
  const published = await readFile(new URL("../packages/website/public/examples/memory-walkthrough.json", import.meta.url), "utf8")
  const evidence = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(metadata))(
    published,
  ))
  const sourceHash = createHash("sha256").update(await readFile(new URL("./memory-walkthrough.ts", import.meta.url))).digest("hex")
  expect(evidence.sourceHash).toBe(sourceHash)
  expect(await readFile(new URL("../packages/website/src/data/memory-walkthrough.json", import.meta.url), "utf8")).toBe(published)
})
