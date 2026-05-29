import type { Tool } from "@effect/ai"
import type { Scope } from "../entities/Scope.js"
import type { AgentConfig } from "./agentConfig.js"
import type { ScopeRuntime } from "./buildScopeRuntime.js"

/**
 * Coder agent config for the **root scope**: the root's system prompt + the
 * root scope's runtime toolkit (base coding tools + `delegate_to_<child>`
 * tools for its direct children). The toolkit's handler Layer
 * (`runtime.handlerLayer`) is provided by the driver at its composition
 * root. Build `rootScope` with `discoverScopeTree` and `runtime` with
 * `buildScopeRuntime(rootScope, …)`.
 */
export const coderAgentConfig = (
  rootScope: Scope,
  runtime: ScopeRuntime,
): AgentConfig<Record<string, Tool.Any>> => ({
  key: `coder:${rootScope.rootDir}`,
  systemPrompt: rootScope.systemPrompt,
  toolkit: runtime.toolkit,
})
