import { Context } from "effect"
import type { OpenSession } from "@xandreed/core/kernel"

/**
 * The open turn a tool call runs in (ADR 0007). A tool's handler is given its
 * parameters only; a tool that must reach the session its call came from (to
 * store a record of its own, or to start a helper under it) declares it,
 * `Tool.make(name, { …, dependencies: [CurrentTurn] })`, and reads it with
 * `yield* CurrentTurn`. The host's loop provides it around each call, as it
 * runs the call: `toolkit.handle(…).pipe(Effect.provideService(CurrentTurn,
 * session))`. A handler that declares it cannot be run without it: the
 * compiler says so where the call is made.
 *
 * @public
 */
export class CurrentTurn extends Context.Service<CurrentTurn, OpenSession>()("@xandreed/sdk/kernel/CurrentTurn") {}
