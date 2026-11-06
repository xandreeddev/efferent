import { Context, Option } from "effect"
import type { ModelSpend } from "@xandreed/core"
import type { ModelSpendOptions } from "../llm/model-spend.entity.js"

/**
 * A spend guard: the `ModelSpend` ledger physical sends reserve and settle
 * in, and the options they are priced and capped by. The models plugin
 * builds one from its `spend` option; a host that builds the
 * OpenAI-compatible model itself passes one as `CompatConfig.spend`.
 *
 * @public
 */
export interface ModelSpendGuard {
  readonly ledger: ModelSpend["Service"]
  readonly options: ModelSpendOptions
}

/** Private: the spend guard a routed call's physical sends reserve with; none when the `spend` option is not set. */
export const CurrentModelSpendGuard = Context.Reference<Option.Option<ModelSpendGuard>>("@xandreed/plugin-models/CurrentModelSpendGuard", { defaultValue: () => Option.none() })
