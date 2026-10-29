import { Schema } from "effect"
import { HarnessError } from "./plugin.entity.js"

const harnessErrorShape = Schema.is(Schema.Struct(HarnessError.fields))

/**
 * Whether a value is a `HarnessError`, by its tag and fields, whichever copy
 * of `@xandreed/core` made it. Two installed copies (a host and a plugin on
 * different versions) each have their own class, so `instanceof
 * HarnessError` is false for the other copy's errors and their codes would
 * be lost; check errors with this instead.
 */
export const isHarnessError = (value: unknown): value is HarnessError => harnessErrorShape(value)
