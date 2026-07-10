/**
 * `bun run math` — a STANDALONE math-practice product on the smith pattern:
 * its own session chassis (one persisted conversation + an event ledger — no
 * Workspace daemon, no fleet), the tutor root (`render_math`-only toolkit +
 * the tutor prompt, no bash, no filesystem) behind the server-rendered math
 * shell. Every launch is a FRESH practice session unless `--resume` names
 * one. With `--grade`/`--theme` the first batch starts generating before the
 * browser even opens; without, the student lands on the setup form and no
 * agent turn runs until they start.
 */
import { HttpServer } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { ConversationStore, Shell } from "@xandreed/engine"
import { WS_PATH } from "./web/contract.js"
import { makeMathSession, type MathRunServices } from "./session.js"
import { composeAgentMessage } from "./protocol.js"
import { browserCommand } from "./web/openBrowser.js"
import { ALL_PATCHES, applyTopic, setError, setGenerating } from "./web/model.js"
import { makeMathPump } from "./web/pump.js"
import { mathRouter } from "./web/server.js"

export interface MathModeInput {
  readonly workspace: string
  readonly version: string
  /** Bind port; absent ⇒ ephemeral. Loopback only. */
  readonly port?: number
  readonly resumeConversationId?: string
  /** Open the printed URL in the default browser. */
  readonly open?: boolean
  readonly grade?: number
  readonly theme?: string
}

const boundPort = (server: HttpServer.HttpServer, fallback: number): number => {
  const addr = server.address
  return addr._tag === "TcpAddress" ? addr.port : fallback
}

export const runMathMode = (
  input: MathModeInput,
): Effect.Effect<void, never, MathRunServices | Shell> =>
  Effect.gen(function* () {
    const conv = yield* ConversationStore
    const shell = yield* Shell

    // A practice session is FRESH by default — only an explicit --resume
    // continues one (the product model: launch = start practicing).
    const existing = yield* conv
      .listByWorkspace(input.workspace)
      .pipe(Effect.orElseSucceed(() => []))
    const resumed =
      input.resumeConversationId !== undefined
        ? existing.find((c) => String(c.id) === input.resumeConversationId)
        : undefined
    const cid = resumed?.id ?? (yield* conv.create(input.workspace).pipe(Effect.orDie))

    const session = yield* makeMathSession({ conversationId: cid, cwd: input.workspace })
    // Replay feeds on the PERSISTED message log (render_math tool-call args +
    // the driver's own machine-formatted user messages) — resume ≡ live-fold.
    const history =
      resumed !== undefined
        ? yield* conv.list(cid).pipe(Effect.orElseSucceed(() => []))
        : []

    const token = crypto.randomUUID().replace(/-/g, "")
    const startScope = {
      ...(input.grade !== undefined ? { grade: input.grade } : {}),
      ...(input.theme !== undefined && input.theme.trim() !== ""
        ? { theme: input.theme.trim() }
        : {}),
    }
    const autoStart =
      resumed === undefined && (startScope.grade !== undefined || startScope.theme !== undefined)

    const serve = Effect.gen(function* () {
      const shutdown = yield* Deferred.make<void>()
      const onShutdown = Effect.forkDaemon(
        Effect.sleep("100 millis").pipe(Effect.zipRight(Deferred.succeed(shutdown, undefined))),
      ).pipe(Effect.asVoid)

      const meta = { title: "efferent math", wsUrl: WS_PATH }
      const pump = yield* makeMathPump(session, meta, history, startScope)

      // A scoped launch starts generating IMMEDIATELY — the first page load
      // shows the skeleton, never a setup flash or a blank canvas. The turn is
      // forked; a failure lands as a retryable error stage, never silence.
      if (autoStart) {
        yield* pump.apply((m) => ({
          model: setGenerating(applyTopic(m, startScope.grade, startScope.theme), true),
          patches: [],
        }))
        yield* Effect.forkDaemon(
          session.send(composeAgentMessage([], { kind: "start", ...startScope })),
        )
      }

      const router = mathRouter({
        identity: { pid: process.pid, workspace: input.workspace, version: input.version },
        pump,
        session,
        meta,
        token,
        onShutdown,
        closed: Deferred.await(shutdown),
      })

      return yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer
        const port = boundPort(server, input.port ?? 0)
        const url = `http://127.0.0.1:${port}/?t=${token}`
        yield* Effect.sync(() =>
          process.stderr.write(`efferent math: ${url}\n  (loopback only · ctrl-c to stop)\n`),
        )
        if (input.open === true) {
          yield* shell
            .exec(browserCommand(url), { cwd: input.workspace })
            .pipe(Effect.ignore)
        }
        yield* Deferred.await(shutdown)
      }).pipe(
        Effect.provide(HttpServer.serve()(router)),
        Effect.provide(BunHttpServer.layer({ port: input.port ?? 0, hostname: "127.0.0.1" })),
      )
    }).pipe(Effect.scoped)

    // Teardown on EVERY exit: interrupt the in-flight turn, then exit
    // explicitly — global daemon-fiber timers otherwise keep Bun alive.
    // The exit code is HONEST: a port-bind or store failure must not print
    // "stopped" and exit 0 (the double-swallow hid every crash; audit).
    const outcome = yield* serve.pipe(
      Effect.ensuring(
        Effect.sync(() => process.stderr.write("efferent math: server closed, finalizing…\n")).pipe(
          Effect.zipRight(session.shutdown),
        ),
      ),
      Effect.exit,
    )
    yield* Exit.match(outcome, {
      onSuccess: () =>
        Effect.sync(() => {
          process.stderr.write("efferent math: stopped\n")
          process.exit(0)
        }),
      onFailure: (cause) =>
        Effect.sync(() => {
          process.stderr.write(`efferent math: FAILED\n${Cause.pretty(cause)}\n`)
          process.exit(1)
        }),
    })
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        process.stderr.write(`efferent math: FAILED\n${Cause.pretty(cause)}\n`)
        process.exit(1)
      }),
    ),
  )
