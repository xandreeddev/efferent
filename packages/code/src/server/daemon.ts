import { HttpServer } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import {
  type AgentDefinition,
  type Scope,
  type Skill,
  AuthStore,
  ContextTreeStore,
  ConversationStore,
  Workspace,
} from "@xandreed/sdk-core"
import { makeInProcessWorkspace, type WorkspaceRunServices } from "../workspace/inProcess.js"
import { makeFleetSupervisor } from "../cli/state/fleet.js"
import { workspaceRouter } from "../transport/http/server.js"
import type { InstructionFile } from "../usecases/discoverInstructionFiles.js"
import type { ToolDefinition } from "../usecases/loadTools.js"
import { removeDiscovery, writeDiscovery } from "./discovery.js"

/**
 * The persistent per-workspace **daemon** — the tmux-style server half. It hosts
 * the authoritative in-process Workspace and serves it over the HTTP/SSE
 * transport; clients attach/detach freely. Distinct from the legacy cron
 * `daemon` mode. On start it writes the discovery file (so a client finds it)
 * and reconciles context nodes stranded `running` by a previous crash; on
 * graceful shutdown it removes the discovery file.
 */

export interface DaemonServeInput {
  readonly workspace: string
  readonly skills: ReadonlyArray<Skill>
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  readonly rootScope: Scope
  readonly version: string
  /** Bind port; 0 (default) ⇒ an ephemeral port, written to the discovery file. */
  readonly port?: number
  readonly allowBash?: boolean
}

/** Read the bound TCP port from the running server's address. */
const boundPort = (server: HttpServer.HttpServer, fallback: number): number => {
  const addr = server.address
  return addr._tag === "TcpAddress" ? addr.port : fallback
}

/**
 * Serve a built Workspace forever on `127.0.0.1:<port>`, writing the discovery
 * file once the real port is known and removing it on teardown. Extracted from
 * the full mode so it's testable with a fake Workspace.
 */
export const serveWorkspaceProgram = (
  ws: ReturnType<typeof Workspace.of>,
  opts: { readonly workspace: string; readonly version: string; readonly port?: number },
): Effect.Effect<never, never, AuthStore> =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const port = boundPort(server, opts.port ?? 0)
    yield* writeDiscovery({
      port,
      pid: process.pid,
      version: opts.version,
      workspace: opts.workspace,
    })
    yield* Effect.addFinalizer(() => removeDiscovery(opts.workspace))
    yield* Effect.sync(() =>
      process.stderr.write(
        `efferent daemon: serving ${opts.workspace} on 127.0.0.1:${port}\n`,
      ),
    )
    return yield* Effect.never
  }).pipe(
    Effect.provide(
      HttpServer.serve()(
        workspaceRouter({ pid: process.pid, workspace: opts.workspace, version: opts.version }),
      ).pipe(Layer.provide(Layer.succeed(Workspace, ws))),
    ),
    Effect.provide(BunHttpServer.layer({ port: opts.port ?? 0, hostname: "127.0.0.1" })),
    Effect.scoped,
  )

/**
 * The full `daemon-serve` mode: resolve/create the workspace's root conversation,
 * reconcile stranded nodes, build the in-process Workspace, and serve forever.
 * Requires the agent-run services (the composition root provides `AppLive`).
 */
export const runDaemonServe = (
  input: DaemonServeInput,
): Effect.Effect<void, never, WorkspaceRunServices | AuthStore> =>
  Effect.gen(function* () {
    const conv = yield* ConversationStore
    const tree = yield* ContextTreeStore

    // Reuse the workspace's most recent conversation (continuity across
    // restarts), else start a fresh one.
    const existing = yield* conv
      .listByWorkspace(input.workspace)
      .pipe(Effect.orElseSucceed(() => []))
    const rootCid =
      existing.length > 0 ? existing[0]!.id : yield* conv.create(input.workspace).pipe(Effect.orDie)

    // Reconcile: flip any node this conversation left `running` (a prior crash)
    // to `error`, so the tree is honest after a restart. Best-effort.
    yield* tree
      .listTree(rootCid)
      .pipe(
        Effect.flatMap((nodes) =>
          Effect.forEach(
            nodes.filter((n) => n.status === "running"),
            (n) =>
              tree
                .recordReturn(n.id, {
                  status: "error",
                  summary: "[daemon restarted — this run was interrupted]",
                  filesChanged: [],
                })
                .pipe(Effect.ignore),
            { discard: true },
          ),
        ),
        Effect.ignore,
      )

    const ws = yield* makeInProcessWorkspace({
      rootConversationId: rootCid,
      rootScope: input.rootScope,
      cwd: input.workspace,
      skills: input.skills,
      agents: input.agents,
      tools: input.tools,
      instructionFiles: input.instructionFiles,
      // No approvalLayer override → the adapter's built-in SERVER approval:
      // bash parks the fiber + publishes `approval_needed` to clients, answered
      // by a client's `POST /approve`. (The judge still auto-allows in-workspace
      // work; only out-of-bounds commands prompt.)
      fleet: makeFleetSupervisor(),
      allowBash: input.allowBash ?? true,
    })

    yield* serveWorkspaceProgram(ws, {
      workspace: input.workspace,
      version: input.version,
      ...(input.port !== undefined ? { port: input.port } : {}),
    })
  })
