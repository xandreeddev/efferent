import { Layer } from "effect"
import { Settings } from "./settings.port.js"

/**
 * The system text an agent's loop and memory read, as a layer. It belongs
 * to the loop contract, not to core: an agent with no loop has none, and
 * the upper stack sets it.
 *
 * @public
 */
export const settings = (options: { readonly system: string }): Layer.Layer<Settings> =>
  Layer.succeed(Settings, Settings.of({ system: options.system }))
