import { pipe } from "effect/Function"
import { TestClock } from "effect/testing"
import { Dns } from "effect/net"

export const services = pipe([TestClock, Dns], (modules) => modules)
