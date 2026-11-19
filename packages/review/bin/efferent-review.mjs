#!/usr/bin/env node
// The `efferent-review` command on Node 24, from its TypeScript source: the package is not built, so tsx loads
// `src/main.ts` and the workspace's sources it imports, as the evaluation command line's tests run it on Node.
import { register } from "tsx/esm/api"

register()
await import("../src/main.ts")
