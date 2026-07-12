import { Schema } from "effect"

export const SocialPolicy = Schema.Struct({
  dailyCap: Schema.Number,
  hourlyCap: Schema.Number,
  perAuthorCap: Schema.Number,
  authorCooldownHours: Schema.Number,
  blockedAuthors: Schema.Array(Schema.String),
  bannedPhrases: Schema.Array(Schema.String),
  linkAllowlist: Schema.Array(Schema.String),
  maxMentions: Schema.Number,
})
export type SocialPolicy = typeof SocialPolicy.Type

export const DEFAULT_POLICY: SocialPolicy = {
  dailyCap: 6,
  hourlyCap: 2,
  perAuthorCap: 2,
  authorCooldownHours: 48,
  blockedAuthors: [],
  bannedPhrases: [
    "check out my blog",
    "nice post",
    "great post",
    "as an ai",
    "click here",
    "follow me",
    "link in bio",
  ],
  linkAllowlist: ["xandreed.dev"],
  maxMentions: 1,
}
