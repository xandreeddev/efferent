import { Effect, Layer, Option } from "effect"
import { ImplementorError } from "../domain/Errors.js"
import type { Spec } from "../domain/Spec.js"
import { Implementor } from "../ports/Implementor.js"
import type { ImplementInput } from "../ports/Implementor.js"

export const implementationPrompt = (spec: Spec, feedback: Option.Option<string>): string =>
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
export const implementCommand = (input: ImplementInput, command: ReadonlyArray<string>, timeoutMs = IMPLEMENT_TIMEOUT_MS) => Effect.scoped(Effect.gen(function* () {
    const failed = (cause: unknown) => new ImplementorError({ attempt: input.attempt, message: "claude execution failed", cause })
    const proc = yield* Effect.acquireRelease(
      Effect.try({ try: () => Bun.spawn([...command], { cwd: input.workspaceDir, stdout: "pipe", stderr: "pipe" }), catch: failed }),
      (child) => Effect.sync(() => child.kill("SIGKILL")).pipe(
        Effect.andThen(Effect.tryPromise({ try: () => child.exited, catch: failed })),
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.logWarning("the implementor did not acknowledge termination") }),
        Effect.ignore({ log: "Warn", message: "could not finish implementor cleanup" }),
      ),
    )
    const errorText = { text: "" }
    const drain = (stream: ReadableStream<Uint8Array>, keep: boolean) => Effect.tryPromise({
      try: (signal) => stream.pipeTo(new WritableStream({ write: (bytes: Uint8Array) => { if (keep) errorText.text = (errorText.text + new TextDecoder().decode(bytes)).slice(0, 2000) } }), { signal }),
      catch: failed,
    })
    const [exitCode] = yield* Effect.all([
      Effect.tryPromise({ try: () => proc.exited, catch: failed }), drain(proc.stdout, false), drain(proc.stderr, true),
    ], { concurrency: 3 }).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(failed(new Error("implementor deadline exceeded"))) }))
    if (exitCode !== 0) return yield* Effect.fail(new ImplementorError({ attempt: input.attempt, message: `claude exited ${exitCode}: ${errorText.text}` }))
    return { filesTouched: [] }
  }))

export const ClaudeCliImplementorLive: Layer.Layer<Implementor> = Layer.succeed(Implementor, { implement: (input) => implementCommand(input, ["claude", "-p", implementationPrompt(input.spec, input.feedback), "--permission-mode", "acceptEdits"]) })
