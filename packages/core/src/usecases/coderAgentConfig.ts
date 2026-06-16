import type { Tool } from "@effect/ai"
import type { Prompt } from "../entities/Prompt.js"
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
  prompt?: Prompt,
): AgentConfig<Record<string, Tool.Any>> => ({
  key: `coder:${rootScope.rootDir}`,
  prompt:
    prompt !== undefined
      ? { ...prompt, text: rootScope.systemPrompt }
      : {
          name: "coder",
          version: "1.0.0",
          text: rootScope.systemPrompt,
        },
  toolkit: runtime.toolkit,
})
