#!/usr/bin/env bun
import { Args, Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { classifyMessage } from "@agent/application"
import { LlmLive } from "@agent/adapters"

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

const root = Command.make("agent").pipe(Command.withSubcommands([classify]))

const cli = Command.run(root, { name: "agent", version: "0.0.0" })

cli(process.argv).pipe(
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
