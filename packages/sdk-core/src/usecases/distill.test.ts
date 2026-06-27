import { describe, expect, it } from "bun:test"
import { Context, Effect, Layer } from "effect"
import type { AgentMessage } from "../entities/Conversation.js"
import type { Verdict } from "../entities/Distillation.js"
import {
  type FileReadResult,
  FileNotFound,
  FileSystem,
} from "../ports/FileSystem.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { Verifier, VerifierError } from "../ports/Verifier.js"
import { parseCandidates, renderTranscript, runDistillation } from "./distill.js"

describe("parseCandidates", () => {
  it("decodes a well-formed candidate array and stamps the conversation id", () => {
    const text = JSON.stringify({
      candidates: [
        {
          kind: "constraint",
          name: "typecheck-after-edit",
          description: "run the typecheck after editing TS",
          body: "After editing a TypeScript file, run `bun run typecheck` before claiming done.",
          positions: [3, 7],
        },
      ],
    })
    const out = parseCandidates(text, "conv-1")
    expect(out.length).toBe(1)
    expect(out[0]!.kind).toBe("constraint")
    expect(out[0]!.name).toBe("typecheck-after-edit")
    expect(out[0]!.evidence.conversationId).toBe("conv-1")
    expect(out[0]!.evidence.positions).toEqual([3, 7])
  })

  it("carries scope + source, defaulting project/inferred when the miner omits them", () => {
    const tagged = parseCandidates(
      JSON.stringify({
        candidates: [
          { kind: "constraint", scope: "global", source: "user", name: "use-const", description: "d", body: "b" },
        ],
      }),
      "c",
    )
    expect(tagged[0]).toMatchObject({ scope: "global", source: "user" })

    const bare = parseCandidates(
      JSON.stringify({ candidates: [{ kind: "constraint", name: "x", description: "d", body: "b" }] }),
      "c",
    )
    expect(bare[0]).toMatchObject({ scope: "project", source: "inferred" })
  })

  it("tolerates prose around the JSON object", () => {
    const text =
      'Here are the lessons:\n{"candidates":[{"kind":"skill","name":"x","description":"d","body":"b"}]}\nDone.'
    const out = parseCandidates(text, "c")
    expect(out.length).toBe(1)
    expect(out[0]!.evidence.positions).toEqual([])
  })

  it("returns [] on malformed JSON, no JSON, or a bad kind", () => {
    expect(parseCandidates("not json at all", "c")).toEqual([])
    expect(parseCandidates("{ broken", "c")).toEqual([])
    expect(
      parseCandidates(JSON.stringify({ candidates: [{ kind: "wrong", name: "x", description: "d", body: "b" }] }), "c"),
    ).toEqual([])
  })

  it("drops candidates with an empty name or body", () => {
    const text = JSON.stringify({
      candidates: [
        { kind: "skill", name: "", description: "d", body: "b" },
        { kind: "skill", name: "ok", description: "d", body: "   " },
        { kind: "skill", name: "keep", description: "d", body: "real body" },
      ],
    })
    const out = parseCandidates(text, "c")
    expect(out.length).toBe(1)
    expect(out[0]!.name).toBe("keep")
  })
})

describe("renderTranscript", () => {
  it("indexes each message by position and summarizes tool calls/results", () => {
    const messages: ReadonlyArray<AgentMessage> = [
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool-call", toolCallId: "1", toolName: "grep", input: { pattern: "TODO" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "1", toolName: "grep", output: "src/a.ts:1: TODO", isError: false },
        ],
      },
    ]
    const out = renderTranscript(messages)
    expect(out).toContain("[0] USER: fix the bug")
    expect(out).toContain("[1] assistant:")
    expect(out).toContain("→ grep(")
    expect(out).toContain("[2] tool grep:")
  })

  it("marks tool errors and skips empty assistant turns", () => {
    const messages: ReadonlyArray<AgentMessage> = [
      { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "1", toolName: "Bash", output: "boom", isError: true }],
      },
    ]
    const out = renderTranscript(messages)
    expect(out).not.toContain("[0] assistant:")
    expect(out).toContain("[ERROR]")
  })

  it("returns an empty string for no messages", () => {
    expect(renderTranscript([])).toBe("")
  })
})

// --- orchestrator: Reflector → Verifier → Curator, fail-closed -------------

const ONE_CANDIDATE = JSON.stringify({
  candidates: [
    { kind: "constraint", name: "x", description: "d", body: "some reusable rule" },
  ],
})

const minerLayer = (text: string) =>
  Layer.succeed(UtilityLlm, { complete: () => Effect.succeed({ text }) })

const verifierLayer = (
  refute: Context.Tag.Service<typeof Verifier>["refute"],
) =>
  Layer.succeed(Verifier, {
    refute,
    gate: () => Effect.succeed({ verdict: "sound" as const, reasons: [] }),
  })

const accept = (score: number): Verdict => ({ accept: true, score, reason: "ok" })

const fsLayer = (store: Map<string, string>) =>
  Layer.succeed(FileSystem, {
    read: (path: string) => {
      const content = store.get(path)
      return content === undefined
        ? Effect.fail(new FileNotFound({ path }))
        : Effect.succeed({
            content,
            truncated: false,
            totalLines: content.split("\n").length,
          } satisfies FileReadResult)
    },
    write: (path: string, content: string) =>
      Effect.sync(() => void store.set(path, content)),
    exists: (path: string) => Effect.succeed(store.has(path)),
    list: () => Effect.succeed([]),
    glob: () => Effect.succeed([]),
  })

const MSGS: ReadonlyArray<AgentMessage> = [{ role: "user", content: "hi" }]

const runOrch = (
  store: Map<string, string>,
  verdict: Effect.Effect<Verdict, VerifierError>,
  opts?: { dryRun?: boolean; threshold?: number },
) =>
  Effect.runPromise(
    runDistillation({
      conversationId: "c",
      messages: MSGS,
      repoDir: "/repo",
      ...(opts?.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(minerLayer(ONE_CANDIDATE), verifierLayer(() => verdict), fsLayer(store)),
      ),
    ),
  )

describe("runDistillation", () => {
  it("persists a candidate the gate accepts above threshold", async () => {
    const store = new Map<string, string>()
    const results = await runOrch(store, Effect.succeed(accept(0.9)))
    expect(results.length).toBe(1)
    expect(results[0]!.accepted).toBe(true)
    expect(results[0]!.persisted).toBeDefined()
    expect(store.size).toBe(1)
  })

  it("drops a rejected candidate (no write)", async () => {
    const store = new Map<string, string>()
    const results = await runOrch(store, Effect.succeed({ accept: false, score: 0.1, reason: "no" }))
    expect(results[0]!.accepted).toBe(false)
    expect(results[0]!.persisted).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it("fail-closed: a verifier error becomes a reject, never a persist", async () => {
    const store = new Map<string, string>()
    const results = await runOrch(store, Effect.fail(new VerifierError({ message: "no claude" })))
    expect(results[0]!.accepted).toBe(false)
    expect(results[0]!.verdict.reason).toContain("verifier unavailable")
    expect(store.size).toBe(0)
  })

  it("a user-stated rule BYPASSES the gate AND a global rule routes to the global dir", async () => {
    const store = new Map<string, string>()
    // A miner reply marking the rule as USER-stated + GLOBAL-scoped.
    const userGlobal = JSON.stringify({
      candidates: [
        {
          kind: "constraint",
          scope: "global",
          source: "user",
          name: "use-const",
          description: "use const not let",
          body: "Use const, not let, unless a binding is reassigned.",
        },
      ],
    })
    // A verifier that would REJECT everything — proving the bypass (it's never consulted).
    const rejecting = () => Effect.fail(new VerifierError({ message: "would reject" }))
    const results = await Effect.runPromise(
      runDistillation({
        conversationId: "c",
        messages: MSGS,
        repoDir: "/repo",
        globalDir: "/home",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(minerLayer(userGlobal), verifierLayer(rejecting), fsLayer(store)),
        ),
      ),
    )
    // Persisted despite the rejecting verifier — the human is the authority.
    expect(results[0]!.accepted).toBe(true)
    expect(results[0]!.persisted).toBeDefined()
    expect(results[0]!.verdict.reason).toContain("user")
    // Routed to the GLOBAL dir (~/.efferent), not the project.
    const keys = [...store.keys()]
    expect(keys.some((k) => k.includes("/home/.efferent/CONSTRAINTS.md"))).toBe(true)
    expect(keys.some((k) => k.includes("/repo/.efferent"))).toBe(false)
  })

  it("respects the score threshold", async () => {
    const store = new Map<string, string>()
    const results = await runOrch(store, Effect.succeed(accept(0.5)), { threshold: 0.7 })
    expect(results[0]!.accepted).toBe(false)
    expect(store.size).toBe(0)
  })

  it("dry-run: shows the verdict but writes nothing", async () => {
    const store = new Map<string, string>()
    const results = await runOrch(store, Effect.succeed(accept(0.9)), { dryRun: true })
    expect(results[0]!.accepted).toBe(true)
    expect(results[0]!.persisted).toBeUndefined()
    expect(store.size).toBe(0)
  })
})
