import { Context } from "effect"
import type { Effect } from "effect"
import type { Message } from "@xandreed/core/kernel"

/*
 * A contract of a plugin's own, for the kernel's tests and its guide: no
 * part of core or of the sdk knows it. A plugin declares such a contract in
 * its own folder, in a `.port.ts` file, under a key named after its
 * package; one plugin provides it and others require it.
 */

// #region contract
/** What a summaries plugin gives the plugins that require it: one line that stands for a run of messages. */
export class Summaries extends Context.Service<Summaries, {
  readonly of: (messages: ReadonlyArray<Message>) => Effect.Effect<string>
}>()("@xandreed/sdk/kernel/testing/Summaries") {}
// #endregion contract

/** A second contract, for the tests that need two plugins to require each other. */
export class Glossary extends Context.Service<Glossary, {
  readonly define: (word: string) => string
}>()("@xandreed/sdk/kernel/testing/Glossary") {}
