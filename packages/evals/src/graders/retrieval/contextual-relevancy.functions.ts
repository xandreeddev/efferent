import { Option } from "effect"

export const contextualRelevancy = (statements: ReadonlyArray<boolean>): Option.Option<number> => statements.length ? Option.some(statements.filter(Boolean).length / statements.length) : Option.none()
