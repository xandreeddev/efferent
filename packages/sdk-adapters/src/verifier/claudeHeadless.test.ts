import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { type Candidate, Shell, Verifier } from "@xandreed/sdk-core"
import {
  buildGatePrompt,
  buildRefutePrompt,
  ClaudeHeadlessVerifierLive,
  extractResultText,
  parseDeliverableVerdict,
  parseVerdict,
} from "./claudeHeadless.js"

describe("extractResultText", () => {
  it("pulls `result` out of the Claude Code JSON envelope", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      result: '{"accept": true, "score": 0.9, "reason": "checks out"}',
    })
    expect(extractResultText(stdout)).toContain('"accept": true')
  })

  it("falls back to raw stdout when the envelope doesn't parse", () => {
    const stdout = '{"accept": false, "score": 0.2, "reason": "nope"}'
    expect(extractResultText(stdout)).toBe(stdout)
  })
})

describe("parseVerdict", () => {
  it("decodes a clean verdict", () => {
    const v = parseVerdict('{"accept": true, "score": 0.85, "reason": "verified against the repo"}')
    expect(v).toBeDefined()
    expect(v!.accept).toBe(true)
    expect(v!.score).toBeCloseTo(0.85)
    expect(v!.reason).toBe("verified against the repo")
  })

  it("tolerates prose around the JSON", () => {
    const v = parseVerdict('Verdict:\n{"accept": false, "score": 0.1}\n')
    expect(v).toBeDefined()
    expect(v!.accept).toBe(false)
    expect(v!.reason).toBe("")
  })

  it("returns undefined on no JSON or a missing field", () => {
    expect(parseVerdict("the candidate looks fine")).toBeUndefined()
    expect(parseVerdict('{"score": 0.5}')).toBeUndefined()
  })
})

describe("buildRefutePrompt", () => {
  const cand: Candidate = {
    kind: "constraint",
    name: "run-typecheck",
    description: "run typecheck after edits",
    body: "After editing TS, run `bun run typecheck`.",
    scope: "project",
    source: "inferred",
    evidence: { conversationId: "c1", positions: [4, 9] },
  }

  it("frames the task as refutation, names the candidate, and cites the repo dir", () => {
    const p = buildRefutePrompt(cand, { repoDir: "/repo", existing: [] })
    expect(p).toContain("REFUTE")
    expect(p).toContain("run-typecheck")
    expect(p).toContain("/repo")
    expect(p).toContain('{"accept"')
  })

  it("includes the existing library for the redundancy check", () => {
    const p = buildRefutePrompt(cand, { repoDir: "/repo", existing: ["already-have-this"] })
    expect(p).toContain("already-have-this")
    expect(p).toContain("REDUNDANT")
  })
})

describe("parseDeliverableVerdict", () => {
  it("decodes a sound verdict", () => {
    const v = parseDeliverableVerdict('{"verdict": "sound", "reasons": []}')
    expect(v).toBeDefined()
    expect(v!.verdict).toBe("sound")
    expect(v!.reasons).toEqual([])
  })

  it("decodes needs_work with reasons, trimming empties", () => {
    const v = parseDeliverableVerdict(
      'Verdict:\n{"verdict": "needs_work", "reasons": ["missing the decoder update", "  ", "no test for the edge case"]}',
    )
    expect(v).toBeDefined()
    expect(v!.verdict).toBe("needs_work")
    expect(v!.reasons).toEqual(["missing the decoder update", "no test for the edge case"])
  })

  it("returns undefined on no JSON or a bad verdict value", () => {
    expect(parseDeliverableVerdict("looks fine to me")).toBeUndefined()
    expect(parseDeliverableVerdict('{"verdict": "maybe", "reasons": []}')).toBeUndefined()
  })
})

describe("buildGatePrompt", () => {
  it("validates the deliverable against the task, in the repo, and demands the verdict JSON", () => {
    const p = buildGatePrompt({
      task: "add an autoCollapse field to Settings",
      summary: "added the field + decoder",
      filesChanged: ["Settings.ts", "decoder.ts"],
      repoDir: "/repo",
    })
    expect(p).toContain("VALIDATE")
    expect(p).toContain("add an autoCollapse field to Settings")
    expect(p).toContain("Settings.ts, decoder.ts")
    expect(p).toContain("/repo")
    expect(p).toContain('"verdict"')
  })

  it("no files → judges the PROSE deliverable (research answer + sources), not code", () => {
    const p = buildGatePrompt({
      task: "name two TS agent frameworks with a differentiator each",
      summary: "Mastra (durable workflows); LangGraph (graph state) — https://...",
      filesChanged: [],
      repoDir: "/repo",
    })
    expect(p).toContain("research/analysis swarm")
    expect(p).toContain("SUPPORTED") // judges sources/citations
    expect(p).not.toContain("typecheck") // not the code-gate instructions
    expect(p).not.toContain("Files changed:")
    expect(p).toContain('"verdict"')
  })
})

// --- gate adapter path (deterministic, stub Shell — no real claude) ----------

const stubShell = (stdout: string, exitCode = 0) =>
  Layer.succeed(
    Shell,
    Shell.of({
      exec: () =>
        Effect.succeed({ stdout, stderr: "", exitCode, durationMs: 1, timedOut: false }),
    } as never),
  )

const runGate = (stdout: string, exitCode = 0) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const v = yield* Verifier
      return yield* v
        .gate({ task: "t", summary: "s", filesChanged: ["f.ts"], repoDir: "/repo" })
        .pipe(Effect.either)
    }).pipe(
      Effect.provide(ClaudeHeadlessVerifierLive.pipe(Layer.provide(stubShell(stdout, exitCode)))),
    ),
  )

// The Claude Code `--output-format json` envelope wraps the model's text in `result`.
const envelope = (verdictJson: string) => JSON.stringify({ result: verdictJson })

describe("ClaudeHeadlessVerifierLive.gate (full adapter path)", () => {
  it("parses a needs_work verdict out of the claude JSON envelope", async () => {
    const res = await runGate(
      envelope('{"verdict":"needs_work","reasons":["missing the multiply fn"]}'),
    )
    expect(res._tag).toBe("Right")
    if (res._tag === "Right") {
      expect(res.right.verdict).toBe("needs_work")
      expect(res.right.reasons).toEqual(["missing the multiply fn"])
    }
  })

  it("fails (fail-soft at the caller) on a non-zero claude exit", async () => {
    const res = await runGate("boom", 127)
    expect(res._tag).toBe("Left")
    if (res._tag === "Left") expect(res.left.message).toContain("claude exited 127")
  })

  it("fails on unparseable claude output", async () => {
    const res = await runGate(envelope("the work looks fine to me"))
    expect(res._tag).toBe("Left")
  })

  it("clean-room: sandbox cwd (not the repo), pinned model, --add-dir only for code context", async () => {
    const calls: Array<{ command: string; cwd: string }> = []
    const capturing = Layer.succeed(
      Shell,
      Shell.of({
        exec: (req: { command: string; cwd?: string }) => {
          calls.push({ command: req.command, cwd: req.cwd ?? "" })
          return Effect.succeed({
            stdout: envelope('{"verdict":"sound","reasons":[]}'),
            stderr: "",
            exitCode: 0,
            durationMs: 1,
            timedOut: false,
          })
        },
      } as never),
    )
    const run = (filesChanged: ReadonlyArray<string>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const v = yield* Verifier
          return yield* v.gate({ task: "t", summary: "s", filesChanged, repoDir: "/repo" })
        }).pipe(Effect.provide(ClaudeHeadlessVerifierLive.pipe(Layer.provide(capturing)))),
      )

    await run(["f.ts"]) // coding deliverable → repo access
    await run([]) // prose deliverable → no repo

    expect(calls.length).toBe(2)
    for (const c of calls) {
      expect(c.command).toContain("--model 'claude-opus-4-8'") // pinned
      expect(c.command).toContain("--permission-mode plan") // read-only
      expect(c.cwd).toMatch(/efferent-verify-/) // isolated sandbox, NOT the repo
      expect(c.cwd).not.toBe("/repo")
    }
    expect(calls[0]!.command).toContain("--add-dir '/repo'") // code context → repo
    expect(calls[1]!.command).not.toContain("--add-dir") // prose → no repo
  })
})
