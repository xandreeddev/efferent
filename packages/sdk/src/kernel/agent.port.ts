import { Context } from "effect"

/**
 * The agent handles whose turn the running fiber is inside, innermost last.
 * `send` adds its own handle around the turn it runs, so `with` can tell
 * that it was called from inside a turn of the handle it would replace.
 */
export const TurnsAround = Context.Reference<ReadonlyArray<object>>("@xandreed/sdk/kernel/TurnsAround", { defaultValue: () => [] })
