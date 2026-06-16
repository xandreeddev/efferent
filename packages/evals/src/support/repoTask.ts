import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Ref } from "effect"
import {
  type AgentHooks,
  ApprovalAllowAllLive,
  ConversationStore,
  runAgent,
} from "@efferent/core"
import type { EvalEnv } from "../env.js"
import { buildCoderConfig } from "./coder.js"
import { dockerShellLayer, withSandbox } from "./dockerSandbox.js"
import { readWorkspaceFile, withTempWorkspace } from "./workspace.js"

/**
 * A real-commit task: give the agent the repo state *before* a commit, ask it
 * to implement what the commit did, and score by running the test that shipped
 * with that commit — the ground-truth oracle. Runs in a per-case Docker sandbox
 * (`dockerSandbox.ts`) so the agent's bash + the verify are isolated and cases
 * parallelise safely.
 */
export interface RepoRunOptions {
  /** Test files (workspace-relative) to run for the verdict. */
  readonly testPaths: ReadonlyArray<string>
  /** Canonical test contents, rewritten before verifying so the agent can't
   *  "pass" by editing the test. */
  readonly canonicalTests: Record<string, string>
  /** Files to read back for inspection. */
  readonly readback?: ReadonlyArray<string>
}

export interface RepoRun {
  readonly tools: ReadonlyArray<string>
  readonly finalText: string
  readonly files: Record<string, string>
  readonly testPass: number
  readonly testFail: number
  /** pass / (pass + fail); 1 when the suite is green with no count, 0 on load error. */
  readonly testRatio: number
  /** The suite ran green: exit 0, ≥1 pass, 0 fail. */
  readonly allPass: boolean
  readonly testOutput: string
}

const count = (s: string, re: RegExp): number => {
  const m = s.match(re)
  return m !== null && m[1] !== undefined ? Number(m[1]) : 0
}

export const runRepoTask = (
  files: Record<string, string>,
  prompt: string,
  opts: RepoRunOptions,
): Effect.Effect<RepoRun, unknown, EvalEnv> =>
  withTempWorkspace(files, (dir) =>
    withSandbox(dir, (sb) =>
      Effect.gen(function* () {
        const { config, runtime } = yield* buildCoderConfig(dir)
        const store = yield* ConversationStore
        const id = yield* store.create(dir)
        const toolsRef = yield* Ref.make<ReadonlyArray<string>>([])

        const hooks: AgentHooks = {
          onBeforeToolCall: (e) =>
            Ref.update(toolsRef, (a) => [...a, e.toolName]).pipe(
              Effect.as({ action: "continue" } as const),
            ),
        }

        const result = yield* runAgent(config, id, prompt, hooks, dir).pipe(
          Effect.provide(runtime.handlerLayer),
          Effect.provide(ApprovalAllowAllLive),
          // The agent's Bash runs INSIDE the sandbox container.
          Effect.provide(dockerShellLayer(sb)),
        )

        // Anti-cheat: restore the canonical test(s) on the host (the bind mount
        // makes the container see them) before grading.
        for (const [p, content] of Object.entries(opts.canonicalTests)) {
          writeFileSync(join(dir, p), content)
        }

        const r = sb.exec(`bun test ${opts.testPaths.join(" ")}`, 90_000)
        const out = `${r.stdout}\n${r.stderr}`
        const pass = count(out, /(\d+)\s+pass/)
        const fail = count(out, /(\d+)\s+fail/)
        const total = pass + fail
        const testRatio = total > 0 ? pass / total : r.exitCode === 0 ? 1 : 0
        const allPass = r.exitCode === 0 && fail === 0 && pass > 0

        const tools = yield* Ref.get(toolsRef)
        const readback: Record<string, string> = {}
        for (const rel of opts.readback ?? []) readback[rel] = readWorkspaceFile(dir, rel)

        return {
          tools,
          finalText: result.finalText,
          files: readback,
          testPass: pass,
          testFail: fail,
          testRatio,
          allPass,
          testOutput: out.slice(0, 4000),
        } satisfies RepoRun
      }),
    ),
  )
