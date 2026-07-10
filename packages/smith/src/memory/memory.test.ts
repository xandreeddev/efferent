import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { FactoryRun } from "@xandreed/foundry"
import { ConversationStore, UtilityCompletion, UtilityLlm } from "@xandreed/engine"
import type { AgentMessage } from "@xandreed/engine"
import { LocalFileSystemLive } from "@xandreed/providers"
import type { SmithEvent } from "../domain/SmithEvent.js"
import {
  CorroborateMemory,
  CreateMemory,
  foldMemory,
  InvalidateMemory,
  MemoryId,
  MemoryProvenance,
  UpdateMemory,
} from "./domain.js"
import { appendMemoryEvents, memoryLedgerPath, readMemoryLedger } from "./ledger.js"
import { curateWorkspaceMemory } from "./curate.js"
import { loadWorkspaceMemory, renderMemoryBlock } from "./inject.js"

const prov = (runId: string, at: string) => new MemoryProvenance({ runId, at })
const id = (n: number) => MemoryId.make(`00000000-0000-4000-8000-00000000000${n}`)

describe("foldMemory — the verbs", () => {
  test("create → corroborate → update → invalidate lifecycle", () => {
    const created = foldMemory([
      CreateMemory.make({ id: id(1), topic: "gotcha", statement: "S1", provenance: prov("r1", "2026-01-01") }),
      CreateMemory.make({ id: id(2), topic: "convention", statement: "S2", provenance: prov("r1", "2026-01-01") }),
    ])
    expect(created).toHaveLength(2)
    expect(created[0]?.corroboration).toBe(1)

    const corroborated = foldMemory([
      CreateMemory.make({ id: id(1), topic: "gotcha", statement: "S1", provenance: prov("r1", "2026-01-01") }),
      CorroborateMemory.make({ id: id(1), provenance: prov("r2", "2026-01-02") }),
      UpdateMemory.make({ id: id(1), statement: "S1 sharpened", provenance: prov("r3", "2026-01-03") }),
    ])
    expect(corroborated[0]?.corroboration).toBe(2)
    expect(corroborated[0]?.statement).toBe("S1 sharpened")
    expect(corroborated[0]?.updatedAt).toBe("2026-01-03")
    expect(corroborated[0]?.sources).toEqual(["r1", "r2", "r3"])

    const invalidated = foldMemory([
      CreateMemory.make({ id: id(1), topic: "gotcha", statement: "S1", provenance: prov("r1", "2026-01-01") }),
      InvalidateMemory.make({ id: id(1), reason: "fixed upstream", provenance: prov("r2", "2026-01-02") }),
    ])
    expect(invalidated).toHaveLength(0)
  })

  test("verbs on unknown ids are inert", () => {
    expect(
      foldMemory([
        CorroborateMemory.make({ id: id(9), provenance: prov("r1", "2026-01-01") }),
        UpdateMemory.make({ id: id(9), statement: "x", provenance: prov("r1", "2026-01-01") }),
        InvalidateMemory.make({ id: id(9), reason: "x", provenance: prov("r1", "2026-01-01") }),
      ]),
    ).toEqual([])
  })
})

describe("the memory ledger", () => {
  test("round-trip; a corrupt line is skipped, decodable history loads", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-mem-"))
    const path = memoryLedgerPath(cwd)
    const events = [
      CreateMemory.make({ id: id(1), topic: "build-quirk", statement: "S", provenance: prov("r1", "2026-01-01") }),
      CorroborateMemory.make({ id: id(1), provenance: prov("r2", "2026-01-02") }),
    ]
    await Effect.runPromise(appendMemoryEvents(path, events))
    appendFileSync(path, "{not json\n", "utf-8")
    appendFileSync(path, `${JSON.stringify({ _tag: "unknown-verb" })}\n`, "utf-8")
    const read = await Effect.runPromise(readMemoryLedger(path))
    expect(read).toHaveLength(2)
    expect(read[0]?._tag).toBe("create")
    // Missing file = empty memory.
    expect(await Effect.runPromise(readMemoryLedger(join(cwd, "nope.jsonl")))).toEqual([])
  })
})

describe("renderMemoryBlock", () => {
  const now = new Date("2026-07-09T00:00:00Z")
  const record = (n: number, corroboration: number, updatedAt: string) =>
    foldMemory([
      CreateMemory.make({ id: id(n), topic: "gotcha", statement: `fact ${n}`, provenance: prov("r", updatedAt) }),
      ...Array.from({ length: corroboration - 1 }, () =>
        CorroborateMemory.make({ id: id(n), provenance: prov("r", updatedAt) }),
      ),
    ])[0]!

  test("trusted-first ordering, stale-uncorroborated pruned, bounded, trust shown", () => {
    const fresh = record(1, 1, "2026-07-01T00:00:00Z")
    const trusted = record(2, 3, "2026-01-01T00:00:00Z")
    const stale = record(3, 1, "2025-01-01T00:00:00Z")
    const block = renderMemoryBlock([fresh, trusted, stale], now)
    expect(block).toContain("fact 1")
    expect(block).toContain("fact 2 (seen 3×)")
    expect(block).not.toContain("fact 3")
    expect(block.indexOf("fact 2")).toBeLessThan(block.indexOf("fact 1"))
    expect(renderMemoryBlock([], now)).toBe("")
    expect(renderMemoryBlock([stale], now)).toBe("")
  })
})

/* ------------------------------------------------------------------ */
/* Curation over scripted layers                                       */
/* ------------------------------------------------------------------ */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 }

const run = (cid: string) =>
  Schema.decodeUnknownSync(FactoryRun)({
    id: "33333333-3333-4333-8333-333333333333",
    spec: { goal: "port it", acceptance: [], limits: { maxAttempts: 3, budgetMillis: 1000 } },
    attempts: [
      {
        attempt: 1,
        report: { verdicts: [{ _tag: "pass", gate: "t", durationMs: 1, findings: [] }] },
        filesTouched: [],
        durationMs: 1,
        implementorRef: `conversation:${cid}`,
      },
    ],
    outcome: { _tag: "accepted", attempt: 1 },
    startedAt: 0,
    endedAt: 1,
  })

const CID = "44444444-4444-4444-8444-444444444444"

// Bulky enough that the CLIPPED digest transcript clears MIN_TRAIL_CHARS.
const longTrail: ReadonlyArray<AgentMessage> = [
  { role: "user", content: `port the module. ${"context ".repeat(120)}` },
  ...Array.from({ length: 8 }, (_, i): AgentMessage => ({
    role: "assistant",
    content: [
      {
        type: "text",
        text: `step ${i}: the build needs --preload ./setup.ts or bun test fails. ${"detail ".repeat(40)}`,
      },
    ],
  })),
]

const storeWith = (messages: ReadonlyArray<AgentMessage>) =>
  Layer.succeed(ConversationStore, {
    create: () => Effect.die("unused"),
    append: () => Effect.die("unused"),
    list: () => Effect.succeed(messages),
    listActive: () => Effect.succeed(messages),
    checkpoint: () => Effect.void,
    checkpointAt: () => Effect.void,
    latestCheckpoint: () => Effect.succeed(Option.none()),
    setTitle: () => Effect.void,
    listByWorkspace: () => Effect.succeed([]),
    fork: (id) => Effect.succeed(id),
    prune: () => Effect.succeed(0),
  })

const scriptedUtility = (responses: ReadonlyArray<string>) => {
  const state = { calls: 0 }
  return Layer.succeed(UtilityLlm, {
    complete: () =>
      Effect.sync(() => {
        const text = responses[state.calls] ?? "[]"
        state.calls += 1
        return new UtilityCompletion({ text, usage })
      }),
  })
}

const collectEvents = () => {
  const events: SmithEvent[] = []
  const publish = (event: SmithEvent) =>
    Effect.sync(() => {
      events.push(event)
    })
  return { events, publish }
}

describe("curateWorkspaceMemory", () => {
  test("first run: extraction creates directly (fenced JSON tolerated); event published", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-mem-"))
    const { events, publish } = collectEvents()
    await Effect.runPromise(
      curateWorkspaceMemory({ cwd, run: run(CID), publish }).pipe(
        Effect.provide(LocalFileSystemLive),
        Effect.provide(storeWith(longTrail)),
        Effect.provide(
          scriptedUtility([
            '```json\n[{"topic":"build-quirk","statement":"bun test needs --preload ./setup.ts"}]\n```',
          ]),
        ),
      ),
    )
    const records = foldMemory(await Effect.runPromise(readMemoryLedger(memoryLedgerPath(cwd))))
    expect(records).toHaveLength(1)
    expect(records[0]?.statement).toContain("--preload")
    expect(events).toEqual([
      { type: "memory_updated", created: 1, updated: 0, corroborated: 0, invalidated: 0 },
    ])
    const injected = await Effect.runPromise(loadWorkspaceMemory(cwd))
    expect(Option.getOrThrow(injected)).toContain("--preload")
  })

  test("second run consolidates: corroborate resolves by INDEX to the real id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-mem-"))
    const path = memoryLedgerPath(cwd)
    await Effect.runPromise(
      appendMemoryEvents(path, [
        CreateMemory.make({ id: id(1), topic: "build-quirk", statement: "needs --preload", provenance: prov("r0", "2026-01-01") }),
      ]),
    )
    const { events, publish } = collectEvents()
    await Effect.runPromise(
      curateWorkspaceMemory({ cwd, run: run(CID), publish }).pipe(
        Effect.provide(LocalFileSystemLive),
        Effect.provide(storeWith(longTrail)),
        Effect.provide(
          scriptedUtility([
            '[{"topic":"build-quirk","statement":"the preload flag is required"}]',
            '[{"op":"corroborate","memory":1},{"op":"corroborate","memory":99}]',
          ]),
        ),
      ),
    )
    const records = foldMemory(await Effect.runPromise(readMemoryLedger(path)))
    expect(records).toHaveLength(1)
    // The in-range index corroborated; the out-of-range one was DROPPED.
    expect(records[0]?.corroboration).toBe(2)
    expect(events[0]?.type === "memory_updated" && events[0].corroborated).toBe(1)
  })

  test("a memory reaching the corroboration bar distills a learned-<topic> skill", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-mem-"))
    const path = memoryLedgerPath(cwd)
    // Seed a convention already confirmed twice (create + one corroborate).
    await Effect.runPromise(
      appendMemoryEvents(path, [
        CreateMemory.make({ id: id(1), topic: "convention", statement: "no barrel files", provenance: prov("r0", "2026-01-01") }),
        CorroborateMemory.make({ id: id(1), provenance: prov("r1", "2026-01-02") }),
      ]),
    )
    const { events, publish } = collectEvents()
    await Effect.runPromise(
      curateWorkspaceMemory({ cwd, run: run(CID), publish }).pipe(
        Effect.provide(LocalFileSystemLive),
        Effect.provide(storeWith(longTrail)),
        Effect.provide(
          scriptedUtility([
            '[{"topic":"convention","statement":"barrel files are banned"}]',
            '[{"op":"corroborate","memory":1}]',
          ]),
        ),
      ),
    )
    // The third independent confirmation crosses the bar → the skill is authored.
    const records = foldMemory(await Effect.runPromise(readMemoryLedger(path)))
    expect(records[0]?.corroboration).toBe(3)
    const distilled = events.find((e) => e.type === "skills_distilled")
    expect(distilled?.type === "skills_distilled" && distilled.names).toEqual(["learned-convention"])
    expect(existsSync(join(cwd, ".efferent", "skills", "learned-convention.md"))).toBe(true)
  })

  test("undecodable extraction writes NOTHING and never fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-mem-"))
    const { events, publish } = collectEvents()
    await Effect.runPromise(
      curateWorkspaceMemory({ cwd, run: run(CID), publish }).pipe(
        Effect.provide(LocalFileSystemLive),
        Effect.provide(storeWith(longTrail)),
        Effect.provide(scriptedUtility(["I think the memories are as follows: ..."])),
      ),
    )
    expect(await Effect.runPromise(readMemoryLedger(memoryLedgerPath(cwd)))).toEqual([])
    expect(events).toEqual([])
  })

  test("a trivial trail skips curation entirely (no paid calls)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-mem-"))
    const { events, publish } = collectEvents()
    const state = { calls: 0 }
    await Effect.runPromise(
      curateWorkspaceMemory({ cwd, run: run(CID), publish }).pipe(
        Effect.provide(LocalFileSystemLive),
        Effect.provide(storeWith([{ role: "user", content: "tiny" }])),
        Effect.provide(
          Layer.succeed(UtilityLlm, {
            complete: () =>
              Effect.sync(() => {
                state.calls += 1
                return new UtilityCompletion({ text: "[]", usage })
              }),
          }),
        ),
      ),
    )
    expect(state.calls).toBe(0)
    expect(events).toEqual([])
  })
})
