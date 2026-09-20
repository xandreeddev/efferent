import { Context } from "effect"
import type { Effect } from "effect"
import type { HarnessError } from "@xandreed/core"
export class SocialDraftRunner extends Context.Tag("Social/DraftRunner")<SocialDraftRunner, {
  readonly run: (prompt: string) => Effect.Effect<{ readonly finalText: string }, HarnessError>
}>() {}
