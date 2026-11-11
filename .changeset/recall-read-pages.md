---
"@xandreed/core": patch
"@xandreed/plugin-memory-window": patch
"@xandreed/plugin-memory-summary": patch
---

`recall_context` reads a page already read from what the request shows for its call's result, not from the value the call returned: a page a registry or a host presents as other text is not counted as read, so a call for its text is served. A result the tool never writes is no page either: its last line with no text before it, or text that ends inside a surrogate pair.
