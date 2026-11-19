import type { PointerOptions } from "../../contracts/memory/pointer.entity.js"

/**
 * How the flat memory that points is set up (`flatMemoryWith`).
 *
 * @public
 */
export interface FlatOptions {
  /** Send long tool results as pointers (`pointed`), in the turn that fetched them and in every later one. */
  readonly pointers: PointerOptions
}
