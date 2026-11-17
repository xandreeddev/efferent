---
"@xandreed/sdk": minor
---

The kernel's graph says what its walk did: `walked` gives it step by step (`near` is its first `limit`), and
`withGraph` publishes it for every request as the live event `plugin.graph.recalled` (`recalledEvent`, `recalledOf`).
