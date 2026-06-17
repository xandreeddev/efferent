import { Context, Effect } from "effect"

export interface XNotification {
  readonly id: string
  readonly author: string
  readonly text: string
}

export interface XSearchResult {
  readonly id: string
  readonly author: string
  readonly text: string
  readonly timestamp: string
}

export class XPlatform extends Context.Tag("XPlatform")<
  XPlatform,
  {
    readonly search: (query: string) => Effect.Effect<ReadonlyArray<XSearchResult>, Error>
    readonly getNotifications: () => Effect.Effect<ReadonlyArray<XNotification>, Error>
    readonly postTweet: (text: string, inReplyToId?: string) => Effect.Effect<void, Error>
  }
>() {}
