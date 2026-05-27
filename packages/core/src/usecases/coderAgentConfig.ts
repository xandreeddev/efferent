import type { FileSystem } from "../ports/FileSystem.js"
import type { Shell } from "../ports/Shell.js"
import { buildCodingTools } from "./codingTools.js"
import { coderSystemPrompt } from "../prompts/coder.js"
import type { AgentConfig } from "./notesAgentConfig.js"

export const coderAgentConfig = (
  cwd: string,
  now: Date = new Date(),
): AgentConfig<FileSystem | Shell> => ({
  key: `coder:${cwd}`,
  systemPrompt: coderSystemPrompt(cwd, now),
  tools: buildCodingTools(cwd),
})
