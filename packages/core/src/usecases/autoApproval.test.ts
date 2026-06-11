import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import {
  buildJudgePrompt,
  judgeApproval,
  normalizeFolder,
  parseJudgeVerdict,
} from "./autoApproval.js"

const REQ = {
  tool: "Bash",
  summary: "ls -la src",
  cwd: "/work/repo",
  ruleKey: "cmd:ls",
} as const

describe("parseJudgeVerdict", () => {
  it("accepts a clean allow", () => {
    expect(parseJudgeVerdict(`{"verdict":"allow","reason":"read-only listing"}`)).toEqual({
      verdict: "allow",
      reason: "read-only listing",
    })
  })

  it("accepts a prompt with the out-of-bounds folder", () => {
    expect(
      parseJudgeVerdict(`{"verdict":"prompt","folder":"/etc","reason":"reads outside workspace"}`),
    ).toEqual({ verdict: "prompt", folder: "/etc", reason: "reads outside workspace" })
  })

  it("digs the JSON out of fences or prose", () => {
    expect(parseJudgeVerdict('```json\n{"verdict":"allow"}\n```').verdict).toBe("allow")
    expect(parseJudgeVerdict('Sure! {"verdict":"allow","reason":"fine"} hope that helps').verdict).toBe(
      "allow",
    )
  })

  it("anything that is not a clean allow collapses to prompt", () => {
    expect(parseJudgeVerdict("no json here").verdict).toBe("prompt")
    expect(parseJudgeVerdict(`{"verdict":"maybe"}`).verdict).toBe("prompt")
    expect(parseJudgeVerdict(`{"verdict": ["allow"]}`).verdict).toBe("prompt")
    expect(parseJudgeVerdict(`{broken`).verdict).toBe("prompt")
    expect(parseJudgeVerdict("").verdict).toBe("prompt")
  })

  it("blank folder/reason fields are dropped, not carried as empty strings", () => {
    expect(parseJudgeVerdict(`{"verdict":"prompt","folder":"  ","reason":""}`)).toEqual({
      verdict: "prompt",
    })
  })
})

describe("normalizeFolder", () => {
  it("resolves relative folders against the cwd and strips trailing separators", () => {
    expect(normalizeFolder("../other", "/work/repo")).toBe("/work/other")
    expect(normalizeFolder("/etc/", "/work/repo")).toBe("/etc")
    expect(normalizeFolder("/", "/work/repo")).toBe("/")
  })
})

describe("buildJudgePrompt", () => {
  it("carries the permitted folders, command, and the strict reply contract", () => {
    const prompt = buildJudgePrompt({
      tool: "Bash",
      summary: "cat /etc/hosts",
      cwd: "/work/repo",
      permittedFolders: ["/work/repo", "/tmp/scratch"],
    })
    expect(prompt).toContain("- /work/repo")
    expect(prompt).toContain("- /tmp/scratch")
    expect(prompt).toContain("cat /etc/hosts")
    expect(prompt).toContain("Working directory: /work/repo")
    expect(prompt).toContain('"verdict":"allow"|"prompt"')
    expect(prompt).toContain("When unsure, prompt")
  })
})

describe("judgeApproval", () => {
  const usage = { inputTokens: 200, outputTokens: 20, totalTokens: 220, cacheReadTokens: 0 }

  const stub = (
    text: string,
    seen?: { prompt: string | undefined; role: string | undefined },
  ) =>
    Layer.succeed(UtilityLlm, {
      complete: (prompt: string, options?: { role?: "fast" | "cheap" }) => {
        if (seen !== undefined) {
          seen.prompt = prompt
          seen.role = options?.role
        }
        return Effect.succeed({ text, usage })
      },
    })

  it("an allow verdict passes through with FAST usage attached", async () => {
    const seen: { prompt: string | undefined; role: string | undefined } = {
      prompt: undefined,
      role: undefined,
    }
    const outcome = await Effect.runPromise(
      judgeApproval(REQ, ["/work/repo"]).pipe(
        Effect.provide(stub(`{"verdict":"allow","reason":"listing inside workspace"}`, seen)),
      ),
    )
    expect(outcome.verdict).toBe("allow")
    expect(outcome.usage).toEqual(usage)
    expect(seen.role).toBe("fast")
    expect(seen.prompt).toContain("ls -la src")
  })

  it("a named folder comes back normalized against the request cwd", async () => {
    const outcome = await Effect.runPromise(
      judgeApproval(REQ, ["/work/repo"]).pipe(
        Effect.provide(stub(`{"verdict":"prompt","folder":"../secrets/","reason":"outside"}`)),
      ),
    )
    expect(outcome).toMatchObject({ verdict: "prompt", folder: "/work/secrets" })
  })

  it("a judge failure degrades to prompt — never an error, never an allow", async () => {
    const failing = Layer.succeed(UtilityLlm, {
      complete: () => Effect.fail({ _tag: "UtilityLlmError", message: "429" } as never),
    } as never)
    const outcome = await Effect.runPromise(
      judgeApproval(REQ, ["/work/repo"]).pipe(Effect.provide(failing)),
    )
    expect(outcome).toEqual({ verdict: "prompt" })
  })
})
