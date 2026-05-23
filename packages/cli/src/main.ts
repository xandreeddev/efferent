#!/usr/bin/env bun
import { Args, Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { capture, classifyMessage } from "@agent/application"
import { LlmLive } from "@agent/adapters"
import type { LlmImage } from "@agent/core"

const messageArg = Args.text({ name: "message" })

const classify = Command.make(
  "classify",
  { message: messageArg },
  ({ message }) =>
    classifyMessage(message).pipe(
      Effect.flatMap((c) => Console.log(JSON.stringify(c, null, 2))),
      Effect.provide(LlmLive),
    ),
)

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

const readInput = (
  source: string,
): Effect.Effect<{ text?: string; image?: LlmImage }, Error> =>
  Effect.tryPromise({
    try: async () => {
      if (source === "-") {
        return { text: await Bun.stdin.text() }
      }
      const mime = IMAGE_MIME[extOf(source)]
      if (mime !== undefined) {
        const bytes = new Uint8Array(await Bun.file(source).arrayBuffer())
        return { image: { bytes, mimeType: mime } }
      }
      return { text: await Bun.file(source).text() }
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
    readInput(source).pipe(
      Effect.flatMap((input) => capture(input)),
      Effect.flatMap((markdown) => Console.log(markdown)),
      Effect.provide(LlmLive),
    ),
)

const root = Command.make("agent").pipe(
  Command.withSubcommands([classify, captureCmd]),
)

const cli = Command.run(root, { name: "agent", version: "0.0.0" })

cli(process.argv).pipe(
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
