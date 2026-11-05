import { Schema } from "effect"

/**
 * The content coding of a Server-Sent Events response: Brotli, gzip, or none.
 *
 * @public
 */
export const SseContentEncoding = Schema.Literals(["br", "gzip", "identity"])
export type SseContentEncoding = typeof SseContentEncoding.Type
