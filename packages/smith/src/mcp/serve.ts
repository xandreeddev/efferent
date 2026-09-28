import { McpProtocol, McpServer, Toolkit } from "effect/ai"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { LocalFileSystemLive, LocalShellLive } from "@xandreed/plugin-tools-local"
import {
  LoadSkill,
  makeSmithCodingHandlers,
  ReadFile,
  Grep,
  Glob,
  Ls,
} from "../implementor/codingToolkit.js"
import { StderrPrettyLoggerLive } from "../stderrLogger.js"

/**
 * `smith mcp --cwd <dir>` — smith AS an MCP server: the coder's READ-ONLY
 * exploration subset (read_file / grep / glob / ls) plus `load_skill`, over
 * stdio, so other agents (Claude Code, any MCP client) can browse a
 * workspace with smith's exact tool semantics (caps, exclusions, native
 * search).
 *
 * The v1 GUARD, deliberate: no write_file, no edit_file, no Bash — an
 * exposed server must not hand out mutation. stdout is the WIRE (JSON-RPC);
 * every log rides stderr.
 */

const SERVER_NAME = "smith-workspace"
const SERVER_VERSION = "1.0.0"

/** The exposed subset — additions here are a security decision, not a
 *  convenience: keep it read-only. */
const exposedToolkit = Toolkit.make(ReadFile, Grep, Glob, Ls, LoadSkill)

export const runMcpServe = (cwd: string): Effect.Effect<never, unknown, never> =>
  Layer.launch(
    McpServer.toolkit(exposedToolkit).pipe(
      Layer.provide(
        exposedToolkit.toLayer(
          makeSmithCodingHandlers(cwd).pipe(
            Effect.map((handlers) =>
              exposedToolkit.of({
                read_file: handlers.read_file,
                grep: handlers.grep,
                glob: handlers.glob,
                ls: handlers.ls,
                load_skill: handlers.load_skill,
              }),
            ),
          ),
        ),
      ),
      Layer.provide(
        McpServer.layerStdio({
          name: SERVER_NAME,
          version: SERVER_VERSION,
          // 2025-06-18 first (the revision served before); newer and older
          // clients get their own when they ask for it.
          protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25, McpProtocol.v2025_03_26],
        }),
      ),
      Layer.provide(Layer.mergeAll(LocalFileSystemLive, LocalShellLive, BunServices.layer)),
      // stdout is the JSON-RPC wire — logs MUST ride stderr or the protocol
      // corrupts on the first log line.
      Layer.provide(StderrPrettyLoggerLive),
    ),
  )

export { SERVER_NAME, SERVER_VERSION, exposedToolkit }
