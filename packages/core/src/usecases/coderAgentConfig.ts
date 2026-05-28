import type { ScopedAgentConfig } from "../entities/ScopedAgent.js"
import type { Skill } from "../entities/Skill.js"
import { coderSystemPrompt } from "../prompts/coder.js"
import type { InstructionFile } from "./discoverInstructionFiles.js"
import { codingToolkit } from "./codingToolkit.js"

/**
 * Coder agent: the coding `Toolkit` + a system prompt built from the
 * discovered skills / instruction files. The toolkit's handler Layer is
 * provided by the driver via `codingToolkitLayer(cwd, skills, { allowBash })`.
 *
 * NOTE: scoped sub-agent delegation is temporarily dropped during the
 * @effect/ai migration (the old delegation tools depended on the removed
 * `Llm` port); `scopedAgents` is still threaded into the prompt context.
 */
export const coderAgentConfig = (
  cwd: string,
  skills: ReadonlyArray<Skill> = [],
  scopedAgents: ReadonlyArray<ScopedAgentConfig> = [],
  instructionFiles: ReadonlyArray<InstructionFile> = [],
  now: Date = new Date(),
) => ({
  key: `coder:${cwd}`,
  systemPrompt: coderSystemPrompt(cwd, now, skills, scopedAgents, instructionFiles),
  toolkit: codingToolkit,
})
