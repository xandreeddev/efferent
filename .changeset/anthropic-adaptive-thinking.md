---
"@xandreed/sdk": minor
---

`anthropicModel({ effort })` (`AnthropicEffort`: `low`, `medium` or `high`) asks for the API's adaptive thinking at that effort; left out, nothing of it is sent. The thinking comes back as reasoning parts whose metadata carries the signature, and a reasoning part sent back with that metadata as its options is the thinking block. A thinking block's start with no `signature` key, as Vercel's AI Gateway sends it, is now read as one with the key empty, where Effect AI refused the whole answer before.
