import { isAbsolute, relative } from "node:path"
import { Option } from "effect"
import { WorkspacePath } from "@xandreed/foundry"
import type { LoopEvent } from "@xandreed/engine"

const WRITE_TOOLS = new Set(["edit_file", "write_file"])

/**
 * Pure: the workspace-relative path a successful write-tool call touched,
 * from the engine's `tool_end` event. `None` for reads, failures,
 * unparseable args, or paths outside the workspace. Bash-mediated edits are
 * invisible here by design: receipts are provenance metadata; the gates
 * judge the real snapshot.
 */
export const capturePath = (
  event: LoopEvent & { readonly type: "tool_end" },
  cwd: string,
): Option.Option<WorkspacePath> => {
  if (!event.ok || !WRITE_TOOLS.has(event.toolName)) return Option.none()
  const args = event.args
  const path =
    typeof args === "object" && args !== null && "path" in args
      ? (args as { readonly path?: unknown }).path
      : undefined
  if (typeof path !== "string" || path.length === 0) return Option.none()
  const rel = isAbsolute(path) ? relative(cwd, path) : path
  const normalized = rel.replaceAll("\\", "/")
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    return Option.none()
  }
  return Option.some(WorkspacePath.make(normalized))
}
