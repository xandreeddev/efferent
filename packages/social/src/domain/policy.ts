import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"

/**
 * The social agent's hard policy — every number/list a deterministic gate
 * enforces. Defaults are DELIBERATELY conservative (a build-in-public alias
 * account reads as spam long before a big account would); `policy.json`
 * overlays them field by field, so loosening a cap is an explicit, reviewed
 * edit — never a prompt change.
 */
export class SocialPolicy extends Schema.Class<SocialPolicy>("SocialPolicy")({
  /** Max posted engagements per rolling 24h. */
  dailyCap: Schema.Number,
  /** Max posted engagements per rolling hour. */
  hourlyCap: Schema.Number,
  /** Max posted engagements to ONE author per rolling 7 days. */
  perAuthorCap: Schema.Number,
  /** Min hours between two posted engagements to the same author. */
  authorCooldownHours: Schema.Number,
  /** Handles never engaged (with or without @, case-insensitive). */
  blockedAuthors: Schema.Array(Schema.String),
  /** Case-insensitive phrases that hard-reject a draft (spam tells, hype). */
  bannedPhrases: Schema.Array(Schema.String),
  /** Domains a draft may link to. Anything else is rejected. */
  linkAllowlist: Schema.Array(Schema.String),
  /** Max @-mentions per draft. */
  maxMentions: Schema.Number,
}) {}

export const DEFAULT_POLICY: SocialPolicy = new SocialPolicy({
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
})

const decodePartial = Schema.decodeUnknownEither(Schema.partial(Schema.Struct(SocialPolicy.fields)))

/** Load the policy: defaults overlaid by `policy.json` when present. A missing
 *  or malformed file means the DEFAULTS apply (fail-closed: the conservative
 *  numbers, never zero policy). */
export const loadPolicy = (path: string): Effect.Effect<SocialPolicy> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf-8"),
    catch: () => "missing" as const,
  }).pipe(
    Effect.map((text) => {
      const parsed = Effect.runSync(
        Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => undefined }).pipe(
          Effect.orElseSucceed(() => undefined),
        ),
      )
      if (parsed === undefined) return DEFAULT_POLICY
      const overlay = decodePartial(parsed)
      if (overlay._tag !== "Right") return DEFAULT_POLICY
      const defined = Object.fromEntries(
        Object.entries(overlay.right).filter(([, v]) => v !== undefined),
      )
      return new SocialPolicy({ ...DEFAULT_POLICY, ...defined })
    }),
    Effect.orElseSucceed(() => DEFAULT_POLICY),
  )
