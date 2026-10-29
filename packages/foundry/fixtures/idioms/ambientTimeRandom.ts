import { Clock, Random } from "effect"
import { randomUUID } from "node:crypto"

export const now = () => Date.now()
export const today = () => new Date()
export const roll = () => Math.random()
export const id = () => crypto.randomUUID()
export const imported = () => randomUUID()
export const parsed = new Date(0)
export const clock = Clock.currentTimeMillis
export const drawn = Random.next
