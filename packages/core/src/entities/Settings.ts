import { Schema } from "effect"

export const Settings = Schema.Struct({
  allowBash: Schema.Boolean.annotations({
    description: "Whether the agent can execute bash commands without prompting in non-interactive modes.",
  }),
  maxSteps: Schema.Number.annotations({
    description: "The maximum number of steps allowed in the agent loop.",
  }),
})

export type Settings = typeof Settings.Type

export const DefaultSettings: Settings = {
  allowBash: false,
  maxSteps: 20,
}
