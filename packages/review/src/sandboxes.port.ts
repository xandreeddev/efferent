import { Context } from "effect"
import type { Effect, Scope } from "effect"
import type { Shell } from "@xandreed/sdk"
import type { SandboxPlan } from "./sandbox.entity.js"

/**
 * Makes sandboxes on this host: `shell(plan)` answers a `Shell` whose every command runs in a sandbox of the plan (its
 * work folder the only writable place but the plan's binds, the network only when the plan shares it), each command
 * stopped with every process it started when it ends or the scope closes. A host that cannot make one fails where
 * the layer is built (`SandboxUnavailable`), never here. `tools` names the programs of the host's toolchain a sandbox
 * holds (`bun`, `node`, `npm`, `pnpm`, `yarn`).
 */
export class Sandboxes extends Context.Service<Sandboxes, {
  readonly tools: ReadonlyArray<string>
  readonly shell: (plan: SandboxPlan) => Effect.Effect<Shell["Service"], never, Scope.Scope>
}>()("@xandreed/review/Sandboxes") {}
