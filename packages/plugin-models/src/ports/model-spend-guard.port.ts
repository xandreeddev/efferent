import { Context, Option } from "effect"
import type { ModelSpend } from "@xandreed/core"
import type { ModelSpendOptions } from "../llm/model-spend.entity.js"

/** The ledger the `spend` option guards sends with, and its options. */
export interface ModelSpendGuard {
  readonly ledger: ModelSpend["Service"]
  readonly options: ModelSpendOptions
}

/** Private: the spend guard a routed call's physical sends reserve with; none when the `spend` option is not set. */
export const CurrentModelSpendGuard = Context.Reference<Option.Option<ModelSpendGuard>>("@xandreed/plugin-models/CurrentModelSpendGuard", { defaultValue: () => Option.none() })
