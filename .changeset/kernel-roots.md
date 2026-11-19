---
"@xandreed/core": minor
"@xandreed/sdk": minor
---

The kernel is each package's root: import `@xandreed/core`, `@xandreed/sdk` and the Node entry `@xandreed/sdk/node`.
The `./kernel` and `./kernel/node` subpaths are gone; service keys keep their `@xandreed/<package>/kernel/<Name>`
prefix (ADR 0036).
