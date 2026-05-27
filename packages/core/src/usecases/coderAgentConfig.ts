import type { AgentHooks } from "../entities/AgentHooks.js"
import type { ScopedAgentConfig } from "../entities/ScopedAgent.js"
import type { Skill } from "../entities/Skill.js"
import type { FileSystem } from "../ports/FileSystem.js"
import type { Llm } from "../ports/Llm.js"
import type { Shell } from "../ports/Shell.js"
import { buildCodingTools } from "./codingTools.js"
import { coderSystemPrompt } from "../prompts/coder.js"
import type { InstructionFile } from "./discoverInstructionFiles.js"
import type { AgentConfig } from "./notesAgentConfig.js"
import { buildScopedAgentDelegationTool } from "./scopedAgentTools.js"

export const coderAgentConfig = <R = never>(
  cwd: string,
  skills: ReadonlyArray<Skill> = [],
  scopedAgents: ReadonlyArray<ScopedAgentConfig> = [],
  instructionFiles: ReadonlyArray<InstructionFile> = [],
  now: Date = new Date(),
  parentHooks?: AgentHooks<R>,
): AgentConfig<FileSystem | Shell | Llm | R> => ({
  key: `coder:${cwd}`,
  systemPrompt: coderSystemPrompt(cwd, now, skills, scopedAgents, instructionFiles),
  tools: [
    ...buildCodingTools<R>(cwd, skills, parentHooks),
    ...scopedAgents.map((cfg) => buildScopedAgentDelegationTool<R>(cfg, parentHooks)),
  ],
})
