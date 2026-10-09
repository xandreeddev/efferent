import { Option } from "effect"

/** Reference statements supported by retrieved evidence; empty references are unavailable. */
export const contextualRecall = (supported: ReadonlyArray<boolean>): Option.Option<number> => supported.length ? Option.some(supported.filter(Boolean).length / supported.length) : Option.none()
