import { Context } from "effect"

/** What an agent is set up with that its plugins read: the system text, fixed for the agent. */
export class Settings extends Context.Service<Settings, {
  readonly system: string
}>()("@xandreed/core/kernel/Settings") {}
