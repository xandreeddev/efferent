#!/usr/bin/env bun
import { Args, Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import {
  capture,
  deleteCapture,
  getCapture,
  listCaptures,
  saveCapture,
} from "@agent/application"
import {
  DatabaseLive,
  LlmLive,
  PostgresCaptureStoreLive,
} from "@agent/adapters"
import type { LlmImage } from "@agent/core"

/* ------------------------------------------------------------------ */
/* Shared infrastructure                                               */
/* ------------------------------------------------------------------ */

/**
 * One composed Layer for any subcommand that needs the store + LLM.
 * Layers are built once when a command's handler runs (so --help never
 * touches the DB or LLM credentials).
 */
const AppLive = Layer.mergeAll(
  PostgresCaptureStoreLive.pipe(Layer.provide(DatabaseLive)),
  LlmLive,
)

const StoreOnlyLive = PostgresCaptureStoreLive.pipe(Layer.provide(DatabaseLive))

/* ------------------------------------------------------------------ */
/* capture <source>  — extract via LLM and save to Postgres            */
/* ------------------------------------------------------------------ */

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
}

const extOf = (path: string): string => {
  const i = path.lastIndexOf(".")
  return i === -1 ? "" : path.slice(i + 1).toLowerCase()
}

interface CaptureInputs {
  readonly text?: string
  readonly image?: LlmImage
  readonly source: string
}

const readInput = (source: string): Effect.Effect<CaptureInputs, Error> =>
  Effect.tryPromise({
    try: async (): Promise<CaptureInputs> => {
      if (source === "-") {
        return { text: await Bun.stdin.text(), source: "-" }
      }
      const mime = IMAGE_MIME[extOf(source)]
      if (mime !== undefined) {
        const bytes = new Uint8Array(await Bun.file(source).arrayBuffer())
        return { image: { bytes, mimeType: mime }, source }
      }
      return { text: await Bun.file(source).text(), source }
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Failed to read input from ${source}`),
  })

const sourceArg = Args.text({ name: "source" }).pipe(
  Args.withDescription(
    "Path to a text or image file, or `-` to read text from stdin.",
  ),
)

const captureCmd = Command.make(
  "capture",
  { source: sourceArg },
  ({ source }) =>
    Effect.gen(function* () {
      const inputs = yield* readInput(source)
      const result = yield* capture({
        ...(inputs.text !== undefined ? { text: inputs.text } : {}),
        ...(inputs.image !== undefined ? { image: inputs.image } : {}),
      })
      const saved = yield* saveCapture({
        title: result.title,
        body: result.body,
        source: inputs.source,
      })
      yield* Console.log(`saved ${saved.id.slice(0, 8)}  ${saved.title}\n`)
      yield* Console.log(saved.body)
    }).pipe(Effect.provide(AppLive)),
)

/* ------------------------------------------------------------------ */
/* ls / show / rm — direct CRUD against the store (no LLM)             */
/* ------------------------------------------------------------------ */

const formatRow = (row: {
  id: string
  title: string
  createdAt: Date
}): string => {
  const ts = row.createdAt.toISOString().slice(0, 16).replace("T", " ")
  const shortId = row.id.slice(0, 8)
  const title =
    row.title.length > 60 ? `${row.title.slice(0, 57)}...` : row.title
  return `${ts}  ${shortId}  ${title}`
}

const lsCmd = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const rows = yield* listCaptures()
    if (rows.length === 0) {
      yield* Console.log("(no captures yet — try `agent capture <path>`)")
      return
    }
    yield* Console.log("created           id        title")
    for (const row of rows) {
      yield* Console.log(formatRow(row))
    }
  }).pipe(Effect.provide(StoreOnlyLive)),
)

const idArg = Args.text({ name: "id" }).pipe(
  Args.withDescription("Full UUID or an unambiguous prefix (≥4 chars)."),
)

const showCmd = Command.make("show", { id: idArg }, ({ id }) =>
  getCapture(id).pipe(
    Effect.flatMap((c) => Console.log(c.body)),
    Effect.provide(StoreOnlyLive),
  ),
)

const rmCmd = Command.make("rm", { id: idArg }, ({ id }) =>
  deleteCapture(id).pipe(
    Effect.flatMap(() => Console.log(`removed ${id}`)),
    Effect.provide(StoreOnlyLive),
  ),
)

/* ------------------------------------------------------------------ */
/* Root                                                                */
/* ------------------------------------------------------------------ */

const root = Command.make("agent").pipe(
  Command.withSubcommands([captureCmd, lsCmd, showCmd, rmCmd]),
)

const cli = Command.run(root, { name: "agent", version: "0.0.0" })

cli(process.argv).pipe(
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
