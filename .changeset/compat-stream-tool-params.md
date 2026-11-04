---
"@xandreed/plugin-models": patch
---

Stream OpenAI-compatible tool-call arguments as `tool-params` parts while the reply streams, so `assistant.delta` carries them on the `tool-params` channel.
