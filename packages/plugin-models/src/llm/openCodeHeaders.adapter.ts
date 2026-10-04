import { Effect, Option } from "effect"
import { CurrentPromptCacheKey, RunContext } from "@xandreed/core"

/** OpenCode Go requires a conversation identity on main and auxiliary calls.
 * Resolve the active native session on each request; retain one fallback for
 * the lifetime of a standalone model, never mint an id for each retry. */
export const makeOpenCodeRequestHeaders = Effect.sync(() => crypto.randomUUID()).pipe(Effect.map((fallback) =>
  Effect.all({ run: Effect.serviceOption(RunContext), cacheKey: Effect.service(CurrentPromptCacheKey) }).pipe(Effect.map(({ run, cacheKey }) => ({
    "x-opencode-session": Option.match(run, { onSome: (context) => String(context.session.id), onNone: () => Option.getOrElse(cacheKey, () => fallback) }),
    "user-agent": "efferent/0.8.0-next.0",
  }))),
))
