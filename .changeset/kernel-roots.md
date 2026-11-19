---
"@xandreed/core": minor
"@xandreed/sdk": minor
---

The kernel is each package's root: import `@xandreed/core`, `@xandreed/sdk` and the Node entry `@xandreed/sdk/node`.
The `./kernel` and `./kernel/node` subpaths are gone. Service keys are `@xandreed/<package>/<Name>` (on the Node
entry `@xandreed/sdk/node/<Name>`; `Memory` is `@xandreed/sdk/Memory`), frozen from this release, their first (ADR 0036).
