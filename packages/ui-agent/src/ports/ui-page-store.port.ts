import { Context, Effect } from "effect"
import type { ConversationId } from "@xandreed/engine"
import type { UiPageEvent } from "../domain/ui-page.entity.js"

export interface UiPageStoreService {
  readonly append: (conversationId: ConversationId, event: UiPageEvent) => Effect.Effect<void, string>
  readonly list: (conversationId: ConversationId) => Effect.Effect<ReadonlyArray<UiPageEvent>, string>
}

export class UiPageStore extends Context.Tag("@xandreed/ui-agent/UiPageStore")<UiPageStore, UiPageStoreService>() {}
