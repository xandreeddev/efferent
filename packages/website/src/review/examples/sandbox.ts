import { Layer } from "effect"
import { directoryCache, sandboxValidations } from "@xandreed/review"
import type { Sandboxes } from "@xandreed/review"

// A host's own sandboxes: a container or a virtual machine, as long as each command runs with the plan's binds and
// network and is stopped with every process it started. The stock one is bwrapSandboxes.
declare const containerSandboxes: Layer.Layer<Sandboxes>
declare const cacheRoot: string

// Validations as the command line builds them, with the sandboxes swapped. The checks that guard the base (on the
// default branch, dependency files unchanged) live in validate itself, so no Sandboxes can skip them.
export const validations = sandboxValidations.pipe(Layer.provide(Layer.mergeAll(containerSandboxes, directoryCache(cacheRoot))))
