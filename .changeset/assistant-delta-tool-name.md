---
"@xandreed/core": patch
"@xandreed/plugin-agent-loop": patch
---

A streamed tool call's first `assistant.delta` on the `tool-params` channel now carries `toolName`, the tool it calls, and the event documents that a `tool-params` `id` is the call's `toolCallId`.
