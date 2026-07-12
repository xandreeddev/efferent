import { describe, expect, test } from "bun:test"
import type { LedgerEntry } from "./ledger.entity.js"
import { DEFAULT_POLICY } from "./social-policy.entity.js"
import type { SocialPolicy } from "./social-policy.entity.js"
import {
  effectiveLength,
  runSocialGates,
  type GateContext,
  type SocialDraft,
} from "./gates.js"

const NOW = new Date("2026-07-07T12:00:00Z")

const row = (over: Partial<LedgerEntry>): LedgerEntry =>
  ({
    at: NOW.toISOString(),
    event: "posted",
    kind: "reply",
    ...over,
  })

const reply = (over?: Partial<SocialDraft>): SocialDraft => ({
  kind: "reply",
  content: "Concrete answer: model the retry as a Schedule and compose it. https://xandreed.dev/posts/effect-retries",
  targetTweetId: "111",
  targetAuthor: "@someone",
  referenceBlogSlug: "effect-retries",
  ...over,
})

const baseCtx: Omit<GateContext, "thread"> = {
  now: NOW,
  ledger: [],
  policy: DEFAULT_POLICY,
  knownSlugs: new Set(["effect-retries", "colocated-evals"]),
  phase: "draft",
}

const THREAD: GateContext["thread"] = [
  { id: "111", author: "@someone", text: "how do I retry in effect?", timestamp: NOW.toISOString() },
]

const ctx = (over?: Partial<GateContext>): GateContext => ({
  ...baseCtx,
  thread: THREAD,
  ...over,
})

/** A context whose thread was NEVER read (exactOptionalPropertyTypes-safe). */
const blindCtx = (over?: Partial<Omit<GateContext, "thread">>): GateContext => ({
  ...baseCtx,
  ...over,
})

const rules = (draft: SocialDraft, c: GateContext): ReadonlyArray<string> =>
  runSocialGates(draft, c).map((f) => f.rule)

describe("the 11 policy gates", () => {
  test("a clean reply passes every gate", () => {
    expect(runSocialGates(reply(), ctx())).toEqual([])
  })

  test("1 dedup — an engaged target never re-engages (discarded counts too)", () => {
    const engaged = ctx({ ledger: [row({ event: "discarded", targetTweetId: "111" })] })
    expect(rules(reply(), engaged)).toContain("dedup")
    // At POST phase only posted/queued rows dedup (a draft row is THIS draft).
    const drafted = ctx({
      ledger: [row({ event: "drafted", targetTweetId: "111" })],
      phase: "post",
    })
    expect(rules(reply(), drafted)).not.toContain("dedup")
  })

  test("2 daily cap", () => {
    const posted = Array.from({ length: DEFAULT_POLICY.dailyCap }, (_, i) =>
      row({ targetTweetId: `t${i}`, at: new Date(NOW.getTime() - (i + 2) * 3_600_000).toISOString() }),
    )
    expect(rules(reply(), ctx({ ledger: posted }))).toContain("daily-cap")
  })

  test("3 hourly cap", () => {
    const posted = Array.from({ length: DEFAULT_POLICY.hourlyCap }, (_, i) =>
      row({ targetTweetId: `t${i}`, at: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString() }),
    )
    expect(rules(reply(), ctx({ ledger: posted }))).toContain("hourly-cap")
  })

  test("4 author cap + cooldown", () => {
    const twoThisWeek = [
      row({ targetTweetId: "a", targetAuthor: "@someone", at: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() }),
      row({ targetTweetId: "b", targetAuthor: "@someone", at: new Date(NOW.getTime() - 4 * 86_400_000).toISOString() }),
    ]
    expect(rules(reply(), ctx({ ledger: twoThisWeek }))).toContain("author-cap")
    const recent = [
      row({ targetTweetId: "a", targetAuthor: "@SOMEONE", at: new Date(NOW.getTime() - 3_600_000).toISOString() }),
    ]
    expect(rules(reply(), ctx({ ledger: recent }))).toContain("author-cooldown")
  })

  test("5 author blocklist (handle-normalized)", () => {
    const policy: SocialPolicy = { ...DEFAULT_POLICY, blockedAuthors: ["someone"] }
    expect(rules(reply({ targetAuthor: "@Someone" }), ctx({ policy }))).toContain("author-blocklist")
  })

  test("6 banned content", () => {
    expect(
      rules(reply({ content: "Nice post! Check out my blog for more." }), ctx()),
    ).toContain("banned-content")
  })

  test("7 t.co-weighted length (bare-domain links weigh 23 too)", () => {
    const url = "https://xandreed.dev/posts/a-very-long-slug-that-would-normally-blow-the-budget-entirely"
    expect(effectiveLength(`x ${url}`)).toBe(2 + 23)
    expect(effectiveLength("x xandreed.dev/posts/a-very-long-slug-here-that-runs-on")).toBe(2 + 23)
    const long = reply({ content: `${"a".repeat(280)} extra` })
    expect(rules(long, ctx())).toContain("length-280")
  })

  test("8 max mentions", () => {
    expect(
      rules(reply({ content: "hey @one @two look at this" }), ctx()),
    ).toContain("max-mentions")
  })

  test("9 link allowlist — schemed AND bare-domain links (X auto-links both)", () => {
    expect(
      rules(reply({ content: "see https://evil.example.com/post" }), ctx()),
    ).toContain("link-allowlist")
    expect(
      rules(reply({ content: "see https://xandreed.dev/posts/effect-retries" }), ctx()),
    ).not.toContain("link-allowlist")
    // Bare domain with a path is a real link on X — the allowlist must see it.
    expect(
      rules(reply({ content: "see evil.example.com/post" }), ctx()),
    ).toContain("link-allowlist")
    expect(
      rules(reply({ content: "walkthrough: xandreed.dev/posts/effect-retries" }), ctx()),
    ).not.toContain("link-allowlist")
    // Pathless prose tokens (Effect.ts, config.json) are NOT links.
    expect(
      rules(reply({ content: "Effect.ts beats config.json for this" }), ctx()),
    ).not.toContain("link-allowlist")
  })

  test("10 thread-context — a reply drafted blind is rejected; post phase skips it", () => {
    expect(rules(reply(), blindCtx())).toContain("thread-context")
    expect(
      rules(reply(), ctx({ thread: [{ id: "999", author: "@x", text: "other", timestamp: NOW.toISOString() }] })),
    ).toContain("thread-context")
    expect(rules(reply(), blindCtx({ phase: "post" }))).not.toContain("thread-context")
    // Standalone posts never need a thread.
    const post: SocialDraft = {
      kind: "post",
      content: "Shipped: colocated evals for the agent loop. https://xandreed.dev/posts/colocated-evals",
      referenceBlogSlug: "colocated-evals",
    }
    expect(rules(post, blindCtx())).toEqual([])
  })

  test("11 blog-slug-exists", () => {
    expect(rules(reply({ referenceBlogSlug: "no-such-post" }), ctx())).toContain("blog-slug-exists")
  })

  test("findings accumulate — a bad draft reports every violation at once", () => {
    const bad = reply({
      content: `Nice post! @a @b @c see https://spam.example.com ${"x".repeat(280)}`,
      referenceBlogSlug: "no-such-post",
    })
    const found = rules(bad, blindCtx())
    expect(found).toEqual(
      expect.arrayContaining([
        "banned-content",
        "length-280",
        "max-mentions",
        "link-allowlist",
        "thread-context",
        "blog-slug-exists",
      ]),
    )
  })
})
