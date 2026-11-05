---
"@xandreed/plugin-models": minor
---

Add the `@xandreed/plugin-models/testing` entry: `scriptedChatCompletions`, a scripted OpenAI-compatible chat-completions endpoint that runs in the process, so tests and evaluations drive the production compat client and the models plugin with no key and no network. It matches requests to steps by order or a predicate, streams text and tool-call arguments in fragments with the usage on the final chunk, records every request, and refuses an unmatched one with an error naming it.
