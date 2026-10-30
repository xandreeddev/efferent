import { PubSub } from "effect"

export const unbounded = PubSub.unbounded<string>()
export const replaying = PubSub.unbounded<string>({ replay: 1 })
export const infinite = PubSub.bounded<string>(Infinity)
export const infiniteOption = PubSub.dropping<string>({ capacity: Number.POSITIVE_INFINITY })
export const signal = PubSub.sliding<void>(1)
export const bounded = PubSub.bounded<string>({ capacity: 16, replay: 1 })
export const dropping = PubSub.dropping<string>(8)
