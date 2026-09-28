import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { asJsonRecord, parseJsonWarn } from "@xandreed/core"

/**
 * `mcpServers` in `.efferent/config.json` — the CONSENT boundary: a server
 * exists only because the human wrote it here. Same two-tier convention as
 * the model settings: global `~/.efferent` merged under local
 * `<cwd>/.efferent` (local wins per server name). Malformed entries drop;
 * a missing file is an empty map — configuration can never brick a run.
 */

export const McpServerSpec = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [])), Schema.withConstructorDefault(Effect.sync(() => []))),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type McpServerSpec = typeof McpServerSpec.Type

const decodeSpec = Schema.decodeUnknownResult(McpServerSpec)

const readTier = (
  dir: string,
): Effect.Effect<ReadonlyArray<readonly [string, McpServerSpec]>> =>
  Effect.tryPromise({
    try: () => readFile(join(dir, ".efferent", "config.json"), "utf-8"),
    catch: () => "missing" as const,
  }).pipe(
    // Corrupt ≠ absent: a malformed config warns instead of silently
    // presenting as "no servers configured".
    Effect.flatMap((text) => parseJsonWarn(text, join(dir, ".efferent", "config.json"))),
    Effect.map((parsed) => {
      const servers = asJsonRecord(parsed)["mcpServers"]
      if (typeof servers !== "object" || servers === null) return []
      return Object.entries(servers).flatMap(([name, raw]) => {
        const decoded = decodeSpec(raw)
        return decoded._tag === "Success" ? [[name, decoded.success] as const] : []
      })
    }),
    Effect.orElseSucceed(() => []),
  )

/** Global merged under local (local wins per name). */
export const readMcpServers = (
  cwd: string,
  home: string,
): Effect.Effect<ReadonlyArray<readonly [string, McpServerSpec]>> =>
  Effect.all([readTier(home), readTier(cwd)]).pipe(
    Effect.map(([global, local]) => [...new Map([...global, ...local]).entries()]),
  )
