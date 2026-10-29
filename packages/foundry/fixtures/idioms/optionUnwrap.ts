import { Option } from "effect"

const found = Option.some(1)
export const nullable = Option.getOrNull(found)
export const missing = Option.getOrUndefined(found)
export const unwrapped = [found].map(Option.getOrNull)
export const kept = Option.getOrElse(found, () => 0)
export const spread = { ...Option.match(found, { onNone: () => ({}), onSome: (value) => ({ value }) }) }
