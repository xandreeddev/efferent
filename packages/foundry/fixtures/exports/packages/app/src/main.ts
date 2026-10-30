import main, { everything, used, type Shape, deprecatedAtSource } from "@fixture/lib"
import * as Lib from "@fixture/lib"
import { extraUsed } from "@fixture/lib/extra"
import { hammer } from "@fixture/lib/tools/hammer"

export { viaReexport } from "@fixture/lib"
// Names nothing, so it uses nothing.
export * from "@fixture/lib"

export const all = [main, everything, used, deprecatedAtSource, Lib.viaNamespace, extraUsed, hammer]
export type Uses = Shape | import("@fixture/lib").ViaType
