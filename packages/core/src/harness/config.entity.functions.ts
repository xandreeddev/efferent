import type { AgentDefinition, HarnessConfig } from "./config.entity.js"

export const defineConfig = <A extends HarnessConfig>(config: A): A => config
export const defineAgent = <A extends AgentDefinition>(agent: A): A => agent
