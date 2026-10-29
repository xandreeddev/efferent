import { Schema } from "effect"

export class StoreFailure extends Schema.TaggedError<StoreFailure>()("StoreFailure", {
  code: Schema.Literals(["busy", "gone"]),
  message: Schema.String,
}) {}

/** The module that declares the codes may compare them. */
export const isBusy = (error: StoreFailure): boolean => error.code === "busy"
