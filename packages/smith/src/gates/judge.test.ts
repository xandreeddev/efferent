import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Metric, Option, Schema } from "effect"
import { Spec, WorkspacePath } from "@xandreed/foundry"
import type { Workspace } from "@xandreed/foundry"
import { extractVerdictJson, gatherEvidence, judgePrompt, makeSmithJudgeGate } from "./judge.js"

const spec = Effect.runSync(
  Schema.decodeUnknown(Spec)({
    goal: "port stats.py",
    acceptance: ["bun test exits 0"],
    limits: { maxAttempts: 3, budgetMillis: 1000 },
  }),
)

const ws = (rootDir: string, files: ReadonlyArray<string>): Workspace => ({
  rootDir,
  files: files.map((f) => WorkspacePath.make(f)),
})

describe("extractVerdictJson", () => {
  test("finds the LAST balanced verdict after prose (braces in reasons survive)", () => {
    const reply = `Reasoning: the code {looks} fine but the test asserts {"sound": "no"} weirdly.
Final answer:
{"sound": false, "reasons": ["stubbed {impl} in stats.ts", "check gamed"]}`
    const raw = Option.getOrThrow(extractVerdictJson(reply))
    expect(JSON.parse(raw)).toEqual({
      sound: false,
      reasons: ["stubbed {impl} in stats.ts", "check gamed"],
    })
    expect(Option.getOrThrow(extractVerdictJson('{"sound": true}'))).toBe('{"sound": true}')
    expect(Option.isNone(extractVerdictJson("I refuse to answer in JSON"))).toBe(true)
    expect(Option.isNone(extractVerdictJson('{"sound": true'))).toBe(true)
  })
})

describe("gatherEvidence", () => {
  test("bounded source contents; excluded trees never leak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"))
    writeFileSync(join(dir, "a.ts"), "export const a = 1")
    writeFileSync(join(dir, "secret.bin"), "BINARY")
    const evidence = await Effect.runPromise(
      gatherEvidence(
        ws(dir, ["a.ts", "secret.bin", "node_modules/x/index.ts", ".foundry/runs/r.json"]),
      ),
    )
    expect(evidence).toContain("=== a.ts ===")
    expect(evidence).toContain("export const a = 1")
    expect(evidence).not.toContain("node_modules")
    expect(evidence).not.toContain(".foundry")
    expect(evidence).not.toContain("BINARY")
    // The prompt embeds goal + acceptance + evidence.
    const prompt = judgePrompt(spec, Option.none(), evidence)
    expect(prompt).toContain("port stats.py")
    expect(prompt).toContain("bun test exits 0")
    expect(prompt).toContain('{"sound"')
  })
})

describe("makeSmithJudgeGate", () => {
  const workspace = ws(mkdtempSync(join(tmpdir(), "judge-ws-")), [])

  test("sound → no findings; unsound → one error finding per reason", async () => {
    const sound = makeSmithJudgeGate({
      spec,
      doc: Option.none(),
      call: () => Effect.succeed('Looks legitimate.\n{"sound": true}'),
    })
    expect(await Effect.runPromise(sound.run(workspace))).toEqual([])
    expect(sound.kind).toBe("judge")
    expect(sound.deterministic).toBe(false)

    const unsound = makeSmithJudgeGate({
      spec,
      doc: Option.none(),
      call: () =>
        Effect.succeed('Reasoning...\n{"sound": false, "reasons": ["stats.ts is a stub"]}'),
    })
    const findings = await Effect.runPromise(unsound.run(workspace))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toBe("stats.ts is a stub")
    expect(findings[0]?.severity).toBe("error")
  })

  test("FAIL-CLOSED: no verdict / undecodable / model failure are all GateCrash", async () => {
    const cases = [
      makeSmithJudgeGate({ spec, doc: Option.none(), call: () => Effect.succeed("no json here") }),
      makeSmithJudgeGate({
        spec,
        doc: Option.none(),
        call: () => Effect.succeed('{"sound": "definitely"}'),
      }),
      makeSmithJudgeGate({ spec, doc: Option.none(), call: () => Effect.fail("provider down") }),
    ]
    const exits = await Promise.all(
      cases.map((gate) => Effect.runPromiseExit(gate.run(workspace))),
    )
    exits.forEach((exit) => {
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("GateCrash")
    })
  })

  test("verdicts move the smith.judge.verdicts counter by outcome", async () => {
    const counter = (verdict: string) =>
      Effect.runPromise(
        Metric.value(
          Metric.tagged(
            Metric.counter("smith.judge.verdicts", {
              description: "judge gate verdicts by outcome",
              incremental: true,
            }),
            "verdict",
            verdict,
          ),
        ),
      ).then((state) => state.count)
    const before = await counter("unsound")
    const beforeCrash = await counter("crash")
    const gate = makeSmithJudgeGate({
      spec,
      doc: Option.none(),
      call: () => Effect.succeed('{"sound": false, "reasons": ["hardcoded output"]}'),
    })
    const findings = await Effect.runPromise(gate.run(workspace))
    expect(findings).toHaveLength(1)
    expect((await counter("unsound")) - before).toBe(1)
    // A crash counts too — a frequently-crashing fail-closed judge is signal.
    const crashing = makeSmithJudgeGate({
      spec,
      doc: Option.none(),
      call: () => Effect.fail("provider down"),
    })
    await Effect.runPromiseExit(crashing.run(workspace))
    expect((await counter("crash")) - beforeCrash).toBe(1)
  })
})
