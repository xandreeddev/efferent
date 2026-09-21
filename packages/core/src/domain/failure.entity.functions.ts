import type { Failure } from "./failure.entity.js"

/** Project an arbitrary defect into the model-readable failure shape. */
export const toFailure = (error: unknown): Failure =>
  error instanceof Error
    ? { error: error.name, message: error.message }
    : { error: "Error", message: String(error) }
