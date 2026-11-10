---
"@xandreed/core": minor
"@xandreed/plugin-memory-window": minor
"@xandreed/plugin-memory-summary": minor
---

`recall_context` returns no text the turn still shows. Within the turn that wrote a result, a call from an offset inside the text the result still shows fails with `ResultShown`, and a call for a page the same turn already read fails with `AlreadyRecalled`; each reply names the offset to pass next, and a new offset is always a page. A model that keeps asking repeats one progress signature, so the step loop's breaker stops it before the step limit. A result of an earlier turn is served as before. The tool's description changes, nothing is stored for the guard, and no strategy version changes.
