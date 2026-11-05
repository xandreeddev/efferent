---
"@xandreed/core": minor
---

A host event's `draft(data)` gives the record the turn's writer stores for it, encoded through the event's schema and JSON exactly as `make` is, as a `TurnDraft` that `Sessions.transact` (or a turn writer's `append` or `transact`) takes without a cast, so a record written outside a turn reads back through `select` like one published in a turn.
