# @agent/cli

CLI driver — a composition root, not business logic.

## What goes here

- `src/main.ts` — `@effect/cli` `Command.make(...)` + `Command.withSubcommands(...)` tree, with handlers that call `@agent/application` use cases and print results.
- Provides the adapter layers (`LlmLive`, future `StorageLive`, etc.) and `BunContext.layer` at the very edge, then hands the program to `BunRuntime.runMain`.

## Rules

- No domain logic. If something looks like a decision about *what* the agent does (vs *how* it's invoked from a terminal), it belongs in `@agent/core` or `@agent/application`.
- Each subcommand is a thin wrapper around one use case. Args/Options are declared with `@effect/cli`'s `Args` / `Options` modules; conversion to use-case input happens in the handler.
- `--help` and `--version` are provided by `@effect/cli` — don't shadow them.
- This package is the *only* place adapter selection happens. To switch the LLM provider, swap the Layer imported here.
