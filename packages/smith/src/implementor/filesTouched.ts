import { isAbsolute, relative } from "node:path"
import { Option } from "effect"
import { WorkspacePath } from "@xandreed/foundry"
import type { AgentAfterToolCallEvent } from "@xandreed/sdk-core"

const WRITE_TOOLS = new Set(["edit_file", "write_file"])

/**
 * Pure: the workspace-relative path a successful write-tool call touched, from
 * the loop's `onAfterToolCall` event (root AND sub-agent events — the code-tier
 * delegate does the edits). `None` for reads, failures, unparseable args, or
 * paths outside the workspace. Bash-mediated edits are invisible here by
 * design: receipts are provenance metadata; the gates judge the real snapshot.
 */
export const capturePath = (
  event: AgentAfterToolCallEvent,
  cwd: string,
): Option.Option<WorkspacePath> => {
  if (!event.ok || !WRITE_TOOLS.has(event.toolName)) return Option.none()
  const args = event.args
  const path =
    typeof args === "object" && args !== null && "path" in args ? args.path : undefined
  if (typeof path !== "string" || path.length === 0) return Option.none()
  const rel = isAbsolute(path) ? relative(cwd, path) : path
  const normalized = rel.replaceAll("\\", "/")
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    return Option.none()
  }
  return Option.some(WorkspacePath.make(normalized))
}
