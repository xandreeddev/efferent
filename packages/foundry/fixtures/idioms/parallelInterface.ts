import { Schema } from "effect"

export const User = Schema.Struct({
  name: Schema.String,
})

export interface User {
  readonly name: string
}

export interface Standalone {
  readonly fine: boolean
}
