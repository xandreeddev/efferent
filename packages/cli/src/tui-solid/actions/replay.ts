import type { AgentMessage, Checkpoint } from "@efferent/sdk-core"
import { projectHistory } from "../presentation/historyProjection.js"
import type { ScrollbackBlock } from "../presentation/conversation.js"

/**
 * The rail-blocks half of `projectHistory` — kept for callers that only need
 * the conversation view of a message set (node previews, tests). Session
 * switches use `projectHistory` directly so the Activity tree and diffstat
 * come from the same walk.
 */
export const replayBlocks = (
  history: ReadonlyArray<AgentMessage>,
  checkpoints: ReadonlyArray<Checkpoint>,
): ScrollbackBlock[] => projectHistory(history, checkpoints).blocks
