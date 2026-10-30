import type { AgentDefinition, HarnessConfig } from "./config.entity.js"

/**
 * @deprecated Write the `HarnessConfig` itself (`satisfies HarnessConfig`
 * keeps its literal type). Removed in the next minor release.
 */
export const defineConfig = <A extends HarnessConfig>(config: A): A => config
/**
 * @deprecated Compose an agent with `Agent.define` (`@xandreed/sdk`). Removed
 * in the next minor release.
 */
export const defineAgent = <A extends AgentDefinition>(agent: A): A => agent
