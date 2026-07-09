import { Deferred, Effect, HashMap, Option, Ref, Schema, Scope, Stream } from "effect"
import { McpError } from "@xandreed/engine"
import type { McpServerSpec } from "./config.js"

/**
 * One MCP server over stdio: newline-delimited JSON-RPC on a Bun.spawn'd
 * child. A single reader fiber correlates responses to pending requests by
 * id (a `Ref` counter → `Deferred` map); the enclosing `Scope`'s finalizer
 * kills the child — a run's end can never leak a server process. Every
 * request rides a hard timeout mapped to failure-as-data upstream.
 */

const REQUEST_TIMEOUT_MS = 60_000

const RpcResponse = Schema.Struct({
  id: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({ code: Schema.optional(Schema.Number), message: Schema.String }),
  ),
})
const decodeResponse = Schema.decodeUnknownEither(RpcResponse)

export interface McpConnection {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, McpError>
  readonly notify: (method: string, params: unknown) => Effect.Effect<void, McpError>
}

export const openStdioConnection = (
  name: string,
  spec: McpServerSpec,
  cwd: string,
): Effect.Effect<McpConnection, McpError, Scope.Scope> =>
  Effect.gen(function* () {
    const fail = (message: string) => new McpError({ server: name, message })

    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.spawn([spec.command, ...spec.args], {
            cwd,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
            env: { ...process.env, ...(spec.env ?? {}) },
          }),
        catch: (cause) => fail(`spawn failed: ${String(cause)}`),
      }),
      (proc) => Effect.sync(() => proc.kill()),
    )

    const pendingRef = yield* Ref.make(HashMap.empty<number, Deferred.Deferred<unknown, McpError>>())
    const idRef = yield* Ref.make(0)

    const send = (payload: Record<string, unknown>) =>
      Effect.try({
        try: () => {
          child.stdin.write(`${JSON.stringify(payload)}\n`)
          child.stdin.flush()
        },
        catch: (cause) => fail(`write failed: ${String(cause)}`),
      })

    // The reader: NDJSON lines → resolve the matching Deferred. Non-response
    // lines (notifications, junk) are ignored; reader death rejects nothing
    // by itself — pending requests die on their own timeouts.
    yield* Effect.forkScoped(
      Stream.fromReadableStream(
        () => child.stdout,
        (cause) => fail(`stdout failed: ${String(cause)}`),
      ).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.gen(function* () {
            const parsed = yield* Effect.try({
              try: () => JSON.parse(line) as unknown,
              catch: () => "not-json" as const,
            }).pipe(Effect.orElseSucceed(() => undefined))
            if (parsed === undefined) return
            const decoded = decodeResponse(parsed)
            if (decoded._tag !== "Right") return
            const response = decoded.right
            const id = response.id
            if (typeof id !== "number") return
            const pending = yield* Ref.get(pendingRef)
            yield* Option.match(HashMap.get(pending, id), {
              onNone: () => Effect.void,
              onSome: (deferred) =>
                Ref.update(pendingRef, HashMap.remove(id)).pipe(
                  Effect.zipRight(
                    response.error !== undefined
                      ? Deferred.fail(deferred, fail(response.error.message))
                      : Deferred.succeed(deferred, response.result),
                  ),
                  Effect.asVoid,
                ),
            })
          }),
        ),
        Effect.catchAll(() => Effect.void),
      ),
    )

    const request = (method: string, params: unknown) =>
      Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(idRef, (n) => n + 1)
        const deferred = yield* Deferred.make<unknown, McpError>()
        yield* Ref.update(pendingRef, HashMap.set(id, deferred))
        yield* send({ jsonrpc: "2.0", id, method, params })
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: REQUEST_TIMEOUT_MS,
            onTimeout: () => fail(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`),
          }),
          Effect.ensuring(Ref.update(pendingRef, HashMap.remove(id))),
        )
      })

    const notify = (method: string, params: unknown) =>
      send({ jsonrpc: "2.0", method, params }).pipe(Effect.asVoid)

    return { request, notify }
  })
