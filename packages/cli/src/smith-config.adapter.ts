import type { HarnessConfig } from "@xandreed/core"
import { smithCapabilitiesPlugin, smithCodingPlugin } from "@xandreed/smith"

/** Project the former Smith tools option onto its new equivalent without rewriting local configuration. */
export const upgradeSmithConfig = (config: HarnessConfig): HarnessConfig => {
  const loop = config.plugins?.find((entry) => entry.id === "loop")
  const tools = config.plugins?.find((entry) => entry.id === "tools")
  if (loop?.use !== smithCodingPlugin.id || tools?.use !== "@xandreed/plugin-tools-local") return config
  return { ...config, plugins: config.plugins?.map((entry) => entry === tools
    ? { ...entry, use: smithCapabilitiesPlugin.id, options: Object.fromEntries(Object.entries(entry.options ?? {}).filter(([key]) => key !== "readOnly")) }
    : entry === loop && typeof tools.options?.readOnly === "boolean" && loop.options?.readOnly === undefined
      ? { ...entry, options: { ...entry.options, readOnly: tools.options.readOnly } } : entry) }
}
