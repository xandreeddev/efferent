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

export const coderAgentConfig = (
  cwd: string,
  skills: ReadonlyArray<Skill> = [],
  scopedAgents: ReadonlyArray<ScopedAgentConfig> = [],
  instructionFiles: ReadonlyArray<InstructionFile> = [],
  now: Date = new Date(),
): AgentConfig<FileSystem | Shell | Llm> => ({
  key: `coder:${cwd}`,
  systemPrompt: coderSystemPrompt(cwd, now, skills, scopedAgents, instructionFiles),
  tools: [
    ...buildCodingTools(cwd, skills),
    ...scopedAgents.map(buildScopedAgentDelegationTool),
  ],
})
