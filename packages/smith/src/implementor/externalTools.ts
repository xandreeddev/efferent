import { Option } from "effect"
import type { McpToolDescriptor } from "@xandreed/core"

/**
 * The system-prompt block that lists the user's MCP tools (progressive
 * disclosure: names + one-liners here, the parameter schema on demand via
 * `mcp_describe`). ONE renderer for both coder paths — the forge implementor
 * and the post-run follow-up — so the conversation's prompt-cache prefix and
 * the coder's persona stay byte-identical across the two.
 */
export const renderExternalToolsBlock = (descriptors: ReadonlyArray<McpToolDescriptor>): string =>
  descriptors.length === 0
    ? ""
    : `## External MCP tools (user-configured servers — call mcp_describe{server, tool} for a tool's parameter schema, then mcp_call{server, tool, args} to run it)\n${descriptors
        .map(
          (d) =>
            `- ${d.server} / ${d.name}: ${Option.getOrElse(d.description, () => "(no description)")}`,
        )
        .join("\n")}`
