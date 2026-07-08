/**
 * Single source of truth for navigation + the landing's ecosystem data.
 * Every internal link in .astro components goes through `href()` so it gets the
 * project-page base (`/efferent`) — markdown links are handled by a rehype plugin.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")

export const href = (path: string): string => {
  if (/^(https?:|mailto:|#|\/\/)/.test(path)) return path
  return BASE + (path.startsWith("/") ? path : "/" + path)
}

export const GITHUB = "https://github.com/xandreeddev/efferent"
export const NPM = "https://www.npmjs.com/package/efferent"

export const topNav = [
  { label: "Docs", href: "/docs/getting-started" },
  { label: "Ecosystem", href: "/#ecosystem" },
  { label: "Agents", href: "/docs/agents/smith" },
]

export interface DocItem {
  slug: string
  label: string
}
export interface DocGroup {
  group: string
  items: DocItem[]
}

export const docsNav: DocGroup[] = [
  {
    group: "Start here",
    items: [{ slug: "getting-started", label: "Getting started" }],
  },
  {
    group: "Concepts",
    items: [
      { slug: "concepts/architecture", label: "Architecture" },
      { slug: "concepts/harness", label: "The harness doctrine" },
      { slug: "concepts/foundry", label: "Foundry — the factory" },
      { slug: "concepts/engine", label: "Engine — the kernel" },
      { slug: "concepts/providers", label: "Providers — the edge" },
      { slug: "concepts/surface", label: "Surface — the UI substrate" },
      { slug: "concepts/evals", label: "Evals — scenario packs" },
      { slug: "concepts/observability", label: "Observability" },
    ],
  },
  {
    group: "The agents",
    items: [
      { slug: "agents/smith", label: "smith — the coder" },
      { slug: "agents/math", label: "math — the tutor" },
      { slug: "agents/canvas", label: "canvas — the page builder" },
      { slug: "agents/social", label: "social — the drafter" },
    ],
  },
]

/** Flat, ordered list of doc slugs — drives prev/next. */
export const docsOrder: DocItem[] = docsNav.flatMap((g) => g.items)

/** The two flagship pillars announced on the landing. */
export const products = [
  {
    name: "The factory",
    logo: "sdk" as const,
    tag: "@xandreed/foundry",
    accent: "var(--ember)",
    blurb:
      "The developer's real output is not code but the system that produces code: a locked spec, an implementor, chained deterministic gates, typed findings routed back as the next brief. The gates declare victory — never the model.",
    points: [
      "forge: implement → snapshot → gates → feedback → retry",
      "Zero-baseline static rules on every commit",
      "The repo runs its own gates on itself",
    ],
    href: "/docs/concepts/foundry",
    cta: "Enter the factory",
  },
  {
    name: "The agent line",
    logo: "cli" as const,
    tag: "bun run smith · math · canvas · social",
    accent: "var(--verdigris)",
    blurb:
      "Purpose-built agents on one shared kernel — a spec-driven coder in a workspace TUI, a math tutor that grades server-side, a page builder whose only output channel is gated HTML, and a social drafter a human must approve. Each one shaped by the strength of its validation oracle.",
    points: [
      "One pure Effect kernel, providers at the edge",
      "Every conversation persisted — auditable evidence",
      "Scenario packs as each agent's regression battery",
    ],
    href: "/docs/agents/smith",
    cta: "Meet the agents",
  },
]

/** The broader "one codebase" capabilities, shown as a grid. */
export const capabilities = [
  {
    title: "The forge loop",
    desc: "Spec in, FactoryRun out: implement → snapshot → staged gate pipeline → typed feedback → retry, bounded by attempts and a wall-clock budget.",
    href: "/docs/concepts/foundry",
  },
  {
    title: "Zero-baseline gates",
    desc: "No try/catch, no let, no loops, no nullable returns — every rule violation anywhere fails typecheck. The baseline only shrinks.",
    href: "/docs/concepts/foundry",
  },
  {
    title: "The routed LanguageModel",
    desc: "Model selection and credentials re-resolve on every call — switch models or log in mid-session and the next turn uses it.",
    href: "/docs/concepts/providers",
  },
  {
    title: "Reasoning, tokens, and the trail",
    desc: "Every turn persists its model, spend, and thinking to SQLite; the TUI renders them live with a context-window gauge.",
    href: "/docs/concepts/engine",
  },
  {
    title: "Scenario evals",
    desc: "Ordered steps over a real agent world, deterministic evidence checks, committed baselines compared by default — key-free in CI.",
    href: "/docs/concepts/evals",
  },
  {
    title: "Observability",
    desc: "OTLP traces with per-turn reasoning and usage, token/latency metrics, a Grafana dashboard, and file logs — one compose file away.",
    href: "/docs/concepts/observability",
  },
]
