import type { XSearchResult } from "../ports/XPlatform.js"
import {
  engagedTweetIds,
  postedInWindow,
  postedToAuthor,
  type LedgerEntry,
} from "./Ledger.js"
import type { SocialPolicy } from "./policy.js"

/**
 * The 11 deterministic policy gates — the social agent's enforcement layer
 * (docs/agents/social.md). Weak oracle ⇒ the gates don't judge "good
 * engagement"; they make the SPAM/OPSEC failure modes structurally impossible
 * and leave taste to the human queue. Foundry's discipline verbatim: pure
 * functions, typed findings, fail-closed, feedback the model can act on.
 *
 * Run at TWO chokepoints: Gate A inside `write_draft` (nothing enters the
 * queue unvalidated — a rejection returns to the model as data) and Gate B on
 * review approval AFTER any human edit (nothing leaves for X unvalidated —
 * the [e]dit path used to post >280 unchecked).
 */
export interface SocialDraft {
  readonly kind: "reply" | "post"
  readonly content: string
  readonly targetTweetId?: string
  readonly targetAuthor?: string
  readonly referenceBlogSlug?: string
}

export interface GateContext {
  readonly now: Date
  readonly ledger: ReadonlyArray<LedgerEntry>
  readonly policy: SocialPolicy
  /** The target thread, fetched by the DRAFTING path (replies only). Absent ⇒
   *  the thread was never read — the trajectory gate rejects. */
  readonly thread?: ReadonlyArray<XSearchResult>
  /** Published blog slugs (the link-target existence gate). */
  readonly knownSlugs: ReadonlySet<string>
  /** Gate B runs post-time checks too (dedup vs POSTED, caps at send). */
  readonly phase: "draft" | "post"
}

export interface SocialFinding {
  readonly rule: string
  readonly detail: string
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

/** t.co wraps every URL to 23 chars regardless of length. */
const T_CO_LENGTH = 23
const URL_RE = /https?:\/\/[^\s]+/g

export const effectiveLength = (content: string): number => {
  const urls = content.match(URL_RE) ?? []
  const withoutUrls = content.replace(URL_RE, "")
  return [...withoutUrls].length + urls.length * T_CO_LENGTH
}

const normalizeHandle = (handle: string): string =>
  handle.trim().toLowerCase().replace(/^@/, "")

type Gate = (draft: SocialDraft, ctx: GateContext) => ReadonlyArray<SocialFinding>

/** 1 · Never engage the same tweet twice (the ledger remembers forever). */
const dedup: Gate = (draft, ctx) => {
  if (draft.targetTweetId === undefined) return []
  const engaged = engagedTweetIds(
    ctx.phase === "post"
      ? ctx.ledger.filter((e) => e.event === "posted" || e.event === "queued")
      : ctx.ledger,
  )
  return engaged.has(draft.targetTweetId)
    ? [
        {
          rule: "dedup",
          detail: `tweet ${draft.targetTweetId} was already engaged — pick a different opportunity`,
        },
      ]
    : []
}

/** 2 · Rolling 24h posted cap. */
const dailyCap: Gate = (_draft, ctx) => {
  const posted = postedInWindow(ctx.ledger, ctx.now, DAY_MS)
  return posted.length >= ctx.policy.dailyCap
    ? [
        {
          rule: "daily-cap",
          detail: `${posted.length}/${ctx.policy.dailyCap} engagements already posted in 24h — stop for today`,
        },
      ]
    : []
}

/** 3 · Rolling 1h posted cap (burst discipline — a metronome reads as a bot). */
const hourlyCap: Gate = (_draft, ctx) => {
  const posted = postedInWindow(ctx.ledger, ctx.now, HOUR_MS)
  return posted.length >= ctx.policy.hourlyCap
    ? [
        {
          rule: "hourly-cap",
          detail: `${posted.length}/${ctx.policy.hourlyCap} engagements posted this hour — wait`,
        },
      ]
    : []
}

/** 4 · Per-author cap + cooldown (repeat replies to one account read as stalking/spam). */
const authorCap: Gate = (draft, ctx) => {
  if (draft.targetAuthor === undefined) return []
  const rows = postedToAuthor(ctx.ledger, draft.targetAuthor)
  const inWeek = rows.filter((e) => ctx.now.getTime() - Date.parse(e.at) < WEEK_MS)
  const cooldownMs = ctx.policy.authorCooldownHours * HOUR_MS
  const inCooldown = rows.some((e) => ctx.now.getTime() - Date.parse(e.at) < cooldownMs)
  return [
    ...(inWeek.length >= ctx.policy.perAuthorCap
      ? [
          {
            rule: "author-cap",
            detail: `${inWeek.length}/${ctx.policy.perAuthorCap} engagements to ${draft.targetAuthor} this week`,
          },
        ]
      : []),
    ...(inCooldown && inWeek.length < ctx.policy.perAuthorCap
      ? [
          {
            rule: "author-cooldown",
            detail: `engaged ${draft.targetAuthor} within the last ${ctx.policy.authorCooldownHours}h — cooling down`,
          },
        ]
      : []),
  ]
}

/** 5 · Author blocklist. */
const blocklist: Gate = (draft, ctx) => {
  if (draft.targetAuthor === undefined) return []
  const target = normalizeHandle(draft.targetAuthor)
  return ctx.policy.blockedAuthors.some((b) => normalizeHandle(b) === target)
    ? [{ rule: "author-blocklist", detail: `${draft.targetAuthor} is blocklisted — skip` }]
    : []
}

/** 6 · Banned content (spam tells, hype phrases; case-insensitive). */
const bannedContent: Gate = (draft, ctx) => {
  const lower = draft.content.toLowerCase()
  return ctx.policy.bannedPhrases
    .filter((phrase) => lower.includes(phrase.toLowerCase()))
    .map((phrase) => ({
      rule: "banned-content",
      detail: `contains the banned phrase "${phrase}" — rewrite without it`,
    }))
}

/** 7 · t.co-weighted length ≤ 280 (the [e]dit path used to post >280 raw). */
const length280: Gate = (draft) => {
  const effective = effectiveLength(draft.content)
  return effective > 280
    ? [
        {
          rule: "length-280",
          detail: `${effective} effective chars (links count ${T_CO_LENGTH}) — cut ${effective - 280}`,
        },
      ]
    : []
}

/** 8 · At most N @-mentions (mention-storms read as spam). */
const maxMentions: Gate = (draft, ctx) => {
  const mentions = draft.content.match(/@[A-Za-z0-9_]+/g) ?? []
  return mentions.length > ctx.policy.maxMentions
    ? [
        {
          rule: "max-mentions",
          detail: `${mentions.length} @-mentions (max ${ctx.policy.maxMentions}) — drop ${mentions.length - ctx.policy.maxMentions}`,
        },
      ]
    : []
}

/** 9 · Links only to allowlisted domains (the alias's own property). */
const linkAllowlist: Gate = (draft, ctx) => {
  const urls = draft.content.match(URL_RE) ?? []
  return urls
    .filter((url) => {
      const host = url.replace(/^https?:\/\//, "").split(/[/?#]/)[0] ?? ""
      return !ctx.policy.linkAllowlist.some(
        (allowed) => host === allowed || host.endsWith(`.${allowed}`),
      )
    })
    .map((url) => ({
      rule: "link-allowlist",
      detail: `link ${url} is off-allowlist (${ctx.policy.linkAllowlist.join(", ")}) — remove it`,
    }))
}

/** 10 · Thread-context trajectory (DRAFT phase only — the read-cache evidence
 *  doesn't survive the queue): a reply must have READ its thread, and the
 *  target id must be in what was read. An out-of-context reply is the classic
 *  embarrassing bot failure. */
const threadContext: Gate = (draft, ctx) => {
  if (draft.kind !== "reply" || ctx.phase !== "draft") return []
  if (draft.targetTweetId === undefined) {
    return [{ rule: "thread-context", detail: "a reply needs targetTweetId" }]
  }
  if (ctx.thread === undefined || ctx.thread.length === 0) {
    return [
      {
        rule: "thread-context",
        detail: "the target thread was not read before drafting — call read_thread first",
      },
    ]
  }
  return ctx.thread.some((t) => t.id === draft.targetTweetId)
    ? []
    : [
        {
          rule: "thread-context",
          detail: `targetTweetId ${draft.targetTweetId} is not in the thread that was read — wrong target?`,
        },
      ]
}

/** 11 · A referenced blog slug must exist (a dead link is worse than no link). */
const blogSlugExists: Gate = (draft, ctx) => {
  if (draft.referenceBlogSlug === undefined) return []
  return ctx.knownSlugs.has(draft.referenceBlogSlug)
    ? []
    : [
        {
          rule: "blog-slug-exists",
          detail: `blog slug "${draft.referenceBlogSlug}" does not exist — use a real slug from read_blog_posts`,
        },
      ]
}

const ALL_GATES: ReadonlyArray<Gate> = [
  dedup,
  dailyCap,
  hourlyCap,
  authorCap,
  blocklist,
  bannedContent,
  length280,
  maxMentions,
  linkAllowlist,
  threadContext,
  blogSlugExists,
]

/** Run every gate; empty = pass. Order is stable so feedback is deterministic. */
export const runSocialGates = (
  draft: SocialDraft,
  ctx: GateContext,
): ReadonlyArray<SocialFinding> => ALL_GATES.flatMap((gate) => gate(draft, ctx))

/** The feedback brief — one line per finding, model- and human-readable. */
export const renderFindings = (findings: ReadonlyArray<SocialFinding>): string =>
  findings.map((f) => `[${f.rule}] ${f.detail}`).join("\n")
