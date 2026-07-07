import { Effect, Layer, Option } from "effect"
import { ImplementorError } from "../domain/Errors.js"
import type { Spec } from "../domain/Spec.js"
import { Implementor } from "../ports/Implementor.js"
import type { ImplementInput } from "../ports/Implementor.js"

const buildPrompt = (spec: Spec, feedback: Option.Option<string>): string =>
  [
    `Implement the following in THIS directory (write TypeScript under ./src). Do not ask questions; just write the code.`,
    ``,
    `## Goal`,
    spec.goal,
    ``,
    `## Acceptance`,
    ...spec.acceptance.map((a) => `- ${a}`),
    ...Option.match(feedback, {
      onNone: () => [],
      onSome: (brief) => [``, `## Previous attempt was rejected`, brief],
    }),
  ].join("\n")

const IMPLEMENT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * A real agent behind the same port — `claude -p` in the workspace (the
 * precedent set by the runtime's `Verifier`). Skeleton-minimal: no receipt
 * introspection (the snapshot + gates judge the result, not the agent's
 * self-report).
 */
export const ClaudeCliImplementorLive: Layer.Layer<Implementor> = Layer.succeed(Implementor, {
  implement: (input: ImplementInput) =>
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          [
            "claude",
            "-p",
            buildPrompt(input.spec, input.feedback),
            "--permission-mode",
            "acceptEdits",
          ],
          { cwd: input.workspaceDir, stdout: "pipe", stderr: "pipe" },
        )
        const timer = setTimeout(() => proc.kill(), IMPLEMENT_TIMEOUT_MS)
        const exitCode = await proc.exited
        clearTimeout(timer)
        const stderr = await new Response(proc.stderr).text()
        return { exitCode, stderr }
      },
      catch: (cause) =>
        new ImplementorError({
          attempt: input.attempt,
          message: `claude spawn failed: ${String(cause)}`,
        }),
    }).pipe(
      Effect.flatMap(({ exitCode, stderr }) =>
        exitCode === 0
          ? Effect.succeed({ filesTouched: [] })
          : Effect.fail(
              new ImplementorError({
                attempt: input.attempt,
                message: `claude exited ${exitCode}: ${stderr.slice(0, 2000)}`,
              }),
            ),
      ),
    ),
})
