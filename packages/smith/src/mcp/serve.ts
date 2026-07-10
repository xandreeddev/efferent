import { McpServer, Toolkit } from "@effect/ai"
import { BunContext, BunSink, BunStream } from "@effect/platform-bun"
import { Effect, Layer, Logger } from "effect"
import { LocalFileSystemLive, LocalShellLive } from "@xandreed/providers"
import {
  LoadSkill,
  makeSmithCodingHandlers,
  ReadFile,
  Grep,
  Glob,
  Ls,
} from "../implementor/codingToolkit.js"

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
          stdin: BunStream.stdin,
          stdout: BunSink.stdout,
        }),
      ),
      Layer.provide(Layer.mergeAll(LocalFileSystemLive, LocalShellLive, BunContext.layer)),
      // stdout is the JSON-RPC wire — logs MUST ride stderr or the protocol
      // corrupts on the first log line.
      Layer.provide(Logger.replace(Logger.defaultLogger, Logger.prettyLogger({ stderr: true }))),
    ),
  )

export { SERVER_NAME, SERVER_VERSION, exposedToolkit }
