import { Context, Option } from "effect"
import type { TurnWriter } from "@xandreed/core"

/** Lexical task execution only; never a host or plugin requirement. */
export const CurrentTaskWriter = Context.Reference<Option.Option<TurnWriter>>("@xandreed/plugin-tasks/CurrentTaskWriter", { defaultValue: () => Option.none() })
