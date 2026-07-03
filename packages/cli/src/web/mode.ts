/**
 * `efferent web` — a standalone, browser-served solo coder: its OWN in-process
 * Workspace (like `efferent code` — no daemon dependency) with the solo-web
 * bounds (direct roster picked by the caller; `maxDepth 1`, `maxChildren 2` by
 * default), plus the HTTP/WS server from `./server.js`. Modeled on
 * `server/daemon.ts` minus discovery — the printed URL (with its one-boot
 * token) IS the discovery.
 */
import { HttpServer } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Deferred, Effect, Layer } from "effect"
import {
  conversationSessionId,
  ConversationStore,
  Shell,
  Workspace,
  type AgentDefinition,
  type Memory,
  type Scope,
  type Skill,
  type ToolDefinition,
  type Settings,
} from "@xandreed/sdk-core"
import { RENDER_UI_KIT_DOC, WS_PATH } from "@xandreed/web"
import { makeFleetSupervisor } from "../cli/state/fleet.js"
import { browserCommand } from "../login/oauthServer.js"
import type { InstructionFile } from "../usecases/discoverInstructionFiles.js"
import { makeInProcessWorkspace, type WorkspaceRunServices } from "../workspace/inProcess.js"
import { makeFragmentPump } from "./pump.js"
import { webRouter } from "./server.js"

export interface WebModeInput {
  readonly workspace: string
  readonly skills: ReadonlyArray<Skill>
  readonly memory: ReadonlyArray<Memory>
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  readonly rootScope: Scope
  readonly settings: Settings
  readonly version: string
  /** Bind port; absent ⇒ ephemeral. Loopback only. */
  readonly port?: number
  readonly resumeConversationId?: string
  /** Open the printed URL in the default browser. */
  readonly open?: boolean
}

/** Default per-run child cap for web mode ("a sub agent or 2"). An explicit
 *  `Settings.subAgentMaxChildren` wins (0 = uncapped, the escape hatch). */
const WEB_DEFAULT_MAX_CHILDREN = 2
/** Web fleet depth: the root may spawn helpers; helpers don't spawn. */
const WEB_MAX_DEPTH = 1

const boundPort = (server: HttpServer.HttpServer, fallback: number): number => {
  const addr = server.address
  return addr._tag === "TcpAddress" ? addr.port : fallback
}

export const runWebMode = (
  input: WebModeInput,
): Effect.Effect<void, never, WorkspaceRunServices> =>
  Effect.gen(function* () {
    const conv = yield* ConversationStore
    const shell = yield* Shell

    // Resolve the session: --resume, else the workspace's most recent
    // conversation, else a fresh one.
    const existing = yield* conv
      .listByWorkspace(input.workspace)
      .pipe(Effect.orElseSucceed(() => []))
    const resumed =
      input.resumeConversationId !== undefined
        ? existing.find((c) => String(c.id) === input.resumeConversationId)
        : undefined
    const seed = resumed ?? existing[existing.length - 1]
    const cid = seed?.id ?? (yield* conv.create(input.workspace).pipe(Effect.orDie))

    // The render_ui kit doc rides the existing instruction-file prompt channel,
    // so the model knows the component vocabulary + the /action/ui convention.
    const instructionFiles: ReadonlyArray<InstructionFile> = [
      ...input.instructionFiles,
      { path: "<web-ui-kit>", content: RENDER_UI_KIT_DOC },
    ]

    const maxChildren =
      input.settings.subAgentMaxChildren === undefined
        ? WEB_DEFAULT_MAX_CHILDREN
        : input.settings.subAgentMaxChildren
    const ws = yield* makeInProcessWorkspace({
      roots: [
        {
          cid,
          ...(seed?.model !== undefined ? { model: seed.model } : {}),
          ...(seed?.title !== undefined ? { title: seed.title } : {}),
        },
      ],
      rootScope: input.rootScope,
      cwd: input.workspace,
      skills: input.skills,
      memory: input.memory,
      agents: input.agents,
      tools: input.tools,
      instructionFiles,
      // Built-in SERVER approval: bash parks + publishes `approval_needed`;
      // the web sheet answers via POST /action/approve.
      fleet: makeFleetSupervisor(),
      allowBash: true,
      webUi: true,
      maxDepth: WEB_MAX_DEPTH,
      ...(maxChildren > 0 ? { maxChildren } : {}),
    })

    const sessionId = conversationSessionId(cid)
    const token = crypto.randomUUID().replace(/-/g, "")

    const serve = Effect.gen(function* () {
      const shutdown = yield* Deferred.make<void>()
      const onShutdown = Effect.forkDaemon(
        Effect.sleep("100 millis").pipe(Effect.zipRight(Deferred.succeed(shutdown, undefined))),
      ).pipe(Effect.asVoid)

      const meta = {
        sessionTitle: seed?.title ?? "session",
        workspacePath: input.workspace,
        model: input.settings.model,
        wsUrl: WS_PATH,
      }
      const pump = yield* makeFragmentPump(ws, sessionId, meta)

      const router = webRouter({
        identity: { pid: process.pid, workspace: input.workspace, version: input.version },
        pump,
        sessionId,
        meta,
        currentModel: pump.snapshot,
        token,
        onShutdown,
        closed: Deferred.await(shutdown),
      })

      return yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer
        const port = boundPort(server, input.port ?? 0)
        const url = `http://127.0.0.1:${port}/?t=${token}`
        yield* Effect.sync(() =>
          process.stderr.write(`efferent web: ${url}\n  (solo coder · loopback only · ctrl-c to stop)\n`),
        )
        if (input.open === true) {
          yield* shell
            .exec({ command: browserCommand(url), cwd: input.workspace })
            .pipe(Effect.ignore)
        }
        yield* Deferred.await(shutdown)
      }).pipe(
        Effect.provide(
          HttpServer.serve()(router).pipe(Layer.provide(Layer.succeed(Workspace, ws))),
        ),
        Effect.provide(BunHttpServer.layer({ port: input.port ?? 0, hostname: "127.0.0.1" })),
      )
    }).pipe(Effect.scoped)

    // Teardown on EVERY exit: interrupt + await the fleet so runs record an
    // honest killed(shutdown) instead of stranding rows.
    yield* serve.pipe(
      Effect.ensuring(
        Effect.sync(() => process.stderr.write("efferent web: server closed, finalizing…\n")).pipe(
          Effect.zipRight(ws.shutdown),
        ),
      ),
      Effect.catchAll(() => Effect.void),
    )
    yield* Effect.sync(() => process.stderr.write("efferent web: stopped\n"))
    // Teardown is complete (server closed, fleet finalized, node returns
    // recorded) — exit explicitly: global daemon-fiber timers (the workspace
    // sweeper's sleep loop) otherwise keep Bun's event loop alive forever
    // (runMain's default teardown only sets the exit code).
    yield* Effect.sync(() => process.exit(0))
  }).pipe(Effect.catchAll(() => Effect.void))
