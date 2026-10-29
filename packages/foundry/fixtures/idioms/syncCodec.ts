import { Schema } from "effect"

const Count = Schema.Number
export const decoded = Schema.decodeUnknownSync(Count)(1)
export const encoded = Schema.encodeSync(Count)(1)
export const viaResult = Schema.decodeUnknownResult(Count)(1)
export const viaEffect = Schema.encodeEffect(Count)(1)
