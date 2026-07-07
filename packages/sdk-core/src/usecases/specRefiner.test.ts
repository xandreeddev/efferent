import { describe, expect, it } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { ApprovalAllowAllLive } from "../ports/Approval.js"
import { FileSystem } from "../ports/FileSystem.js"
import type { DirEntry } from "../ports/FileSystem.js"
import { Http } from "../ports/Http.js"
import { Shell } from "../ports/Shell.js"
import { TerminalSession } from "../ports/TerminalSession.js"
import { WebSearch } from "../ports/WebSearch.js"
import { SpecSlug } from "../entities/SpecDoc.js"
import { decodeSpecDocText } from "./specCodec.js"
import { makeSpecRefinerHandlers, SPECS_DIR } from "./specRefiner.js"
import { specRefinerPrompt } from "../prompts/specRefiner.js"

/** In-memory FileSystem fake: writes land in a Map; list serves a dir. */
const memoryFs = (seed: ReadonlyArray<string> = []) => {
  const files = new Map<string, string>()
  seed.forEach((path) => files.set(path, ""))
  const layer = Layer.succeed(
    FileSystem,
    FileSystem.of({
      read: (path: string) =>
        files.has(path)
          ? Effect.succeed({ content: files.get(path) ?? "", truncated: false, totalLines: 1 })
          : Effect.fail({ _tag: "FileNotFound", path } as never),
      write: (path: string, content: string) =>
        Effect.sync(() => {
          files.set(path, content)
        }),
      exists: (path: string) => Effect.succeed(files.has(path)),
      list: (dir: string) =>
        Effect.succeed(
          [...files.keys()]
            .filter((path) => path.startsWith(`${dir}/`))
            .map((path): DirEntry => ({ path, type: "file" })),
        ),
      glob: () => Effect.succeed([]),
    } as never),
  )
  return { files, layer }
}

const ports = Layer.mergeAll(
  Layer.succeed(Shell, Shell.of({} as never)),
  Layer.succeed(Http, Http.of({} as never)),
  Layer.succeed(WebSearch, WebSearch.of({} as never)),
  Layer.succeed(TerminalSession, TerminalSession.of({} as never)),
  ApprovalAllowAllLive,
)

const CWD = "/ws"

const propose = (
  fs: ReturnType<typeof memoryFs>,
  params: Parameters<
    Effect.Effect.Success<ReturnType<typeof makeSpecRefinerHandlers>>["propose_spec"]
  >[0],
  options: Parameters<typeof makeSpecRefinerHandlers>[1] = {},
) =>
  Effect.gen(function* () {
    const handlers = yield* makeSpecRefinerHandlers(CWD, options)
    return yield* Effect.either(handlers.propose_spec(params))
  }).pipe(Effect.provide(Layer.mergeAll(fs.layer, ports)), Effect.runPromise)

describe("propose_spec — the refiner's one write", () => {
  const params = {
    goal: "Implement a stats util with tests.",
    acceptance: ["mean returns Option for empty input"],
    constraints: ["keep existing exports"],
    nonGoals: undefined,
    checks: [{ name: "stats-tests", command: "bun test src/stats.test.ts" }],
    maxAttempts: undefined,
    budgetMinutes: undefined,
  }

  it("writes a decodable draft and reports slug + path", async () => {
    const fs = memoryFs()
    const result = await propose(fs, params)
    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") return
    expect(result.right.status).toBe("draft")
    expect(result.right.slug).toBe("implement-a-stats-util-with-tests")
    const written = fs.files.get(result.right.path)
    expect(written).toBeDefined()
    const doc = await Effect.runPromise(decodeSpecDocText(result.right.slug, written ?? ""))
    expect(doc.goal).toBe(params.goal)
    expect(doc.acceptance).toEqual(params.acceptance)
    expect(doc.checks[0]?.command).toBe("bun test src/stats.test.ts")
    expect(doc.status).toBe("draft")
    expect(doc.limits.maxAttempts).toBe(3)
  })

  it("mints the slug ONCE per session — a re-propose rewrites the same file", async () => {
    const fs = memoryFs()
    const both = await Effect.gen(function* () {
      const handlers = yield* makeSpecRefinerHandlers(CWD)
      const first = yield* handlers.propose_spec(params)
      const second = yield* handlers.propose_spec({
        ...params,
        goal: "A completely different goal now.",
      })
      return { first, second }
    }).pipe(Effect.provide(Layer.mergeAll(fs.layer, ports)), Effect.runPromise)
    expect(both.second.slug).toBe(both.first.slug)
    expect(both.second.path).toBe(both.first.path)
    const written = fs.files.get(both.second.path) ?? ""
    expect(written).toContain("A completely different goal now.")
  })

  it("suffixes on collision with existing spec files", async () => {
    const fs = memoryFs([`${CWD}/${SPECS_DIR}/implement-a-stats-util-with-tests.md`])
    const result = await propose(fs, params)
    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") return
    expect(result.right.slug).toBe("implement-a-stats-util-with-tests-2")
  })

  it("an explicit slug option resumes an existing spec in place", async () => {
    const fs = memoryFs()
    const result = await propose(fs, params, { slug: SpecSlug.make("resumed") })
    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") return
    expect(result.right.slug).toBe("resumed")
  })

  it("invalid content is a graceful tool failure, never a crash", async () => {
    const fs = memoryFs()
    const result = await propose(fs, { ...params, goal: "" })
    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") return
    expect((result.left as { error: string }).error).toBe("InvalidSpec")
  })
})

describe("specRefinerPrompt", () => {
  it("teaches the protocol: explore first, propose_spec only, human locks", () => {
    const prompt = specRefinerPrompt("/ws")
    expect(prompt).toContain("EXPLORE FIRST")
    expect(prompt).toContain("propose_spec")
    expect(prompt).toContain("AT MOST 3 numbered questions")
    expect(prompt).toContain("The human locks")
    expect(prompt).toContain("NEVER implement")
  })

  it("the unattended variant asks nothing and records assumptions", () => {
    const prompt = specRefinerPrompt("/ws", { unattended: true })
    expect(prompt).toContain("UNATTENDED")
    expect(prompt).toContain("assumption:")
    expect(prompt).not.toContain("AT MOST 3")
  })
})
