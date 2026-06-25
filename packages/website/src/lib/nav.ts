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
export const NPM = "https://www.npmjs.com/package/@xandreed/code"

export const topNav = [
  { label: "Docs", href: "/docs/getting-started" },
  { label: "Ecosystem", href: "/#ecosystem" },
  { label: "Examples", href: "/docs/examples" },
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
    items: [
      { slug: "getting-started", label: "Getting started" },
      { slug: "your-first-agent", label: "Your first agent" },
    ],
  },
  {
    group: "Concepts",
    items: [
      { slug: "concepts/architecture", label: "Architecture" },
      { slug: "concepts/personal-assistant", label: "The personal assistant" },
      { slug: "concepts/runtime", label: "The runtime" },
      { slug: "concepts/agent-loop", label: "The agent loop" },
      { slug: "concepts/tools", label: "Tools & toolkits" },
      { slug: "concepts/providers", label: "Providers & models" },
      { slug: "concepts/compaction", label: "Context compaction" },
      { slug: "concepts/sub-agents", label: "Sub-agents" },
      { slug: "concepts/fleet", label: "The fleet" },
      { slug: "concepts/daemon", label: "The daemon" },
      { slug: "concepts/control-plane", label: "Control plane & jobs" },
      { slug: "concepts/agent-messaging", label: "Agent messaging" },
      { slug: "concepts/skills", label: "Skills" },
      { slug: "concepts/observability", label: "Observability" },
      { slug: "concepts/evals", label: "Evals" },
    ],
  },
  {
    group: "Guides",
    items: [
      { slug: "guides/define-a-tool", label: "Define a tool" },
      { slug: "guides/composition-root", label: "Composition root" },
      { slug: "guides/hooks", label: "Hooks" },
      { slug: "guides/compression-policy", label: "Compression policy" },
      { slug: "guides/coding-agent", label: "The coding agent" },
      { slug: "guides/sub-agents", label: "Spawning sub-agents" },
      { slug: "guides/fleet", label: "Run a fleet" },
      { slug: "guides/using-efferent", label: "Using efferent" },
    ],
  },
  {
    group: "Reference",
    items: [
      { slug: "reference/agent-config", label: "AgentConfig" },
      { slug: "reference/run-agent", label: "runAgent" },
      { slug: "reference/hooks", label: "AgentHooks" },
      { slug: "reference/compression", label: "Compression & Compaction" },
      { slug: "reference/ports", label: "Ports" },
      { slug: "reference/adapters", label: "Adapter layers" },
      { slug: "reference/settings", label: "Settings" },
      { slug: "reference/cli", label: "CLI & modes" },
    ],
  },
  {
    group: "Examples",
    items: [
      { slug: "examples", label: "Overview" },
      { slug: "examples/dice-agent", label: "Dice agent" },
      { slug: "examples/calc-agent", label: "Calculator agent" },
      { slug: "examples/file-agent", label: "File agent" },
      { slug: "examples/hooks-agent", label: "Hooks agent" },
      { slug: "examples/compression-agent", label: "Compression agent" },
    ],
  },
]

/** Flat, ordered list of doc slugs — drives prev/next. */
export const docsOrder: DocItem[] = docsNav.flatMap((g) => g.items)

/** The two flagship products announced on the landing. */
export const products = [
  {
    name: "efferent SDK",
    logo: "sdk" as const,
    tag: "@xandreed/sdk-core",
    accent: "var(--ember)",
    blurb:
      "The agent framework: entities, ports, and use cases as Effect Layers; tools as an @effect/ai Toolkit; every error tagged; the provider a runtime choice. Build your own agent in a handful of lines.",
    points: ["The agent loop as one Effect", "Ports & adapters, typed errors", "Cache-safe context compaction"],
    href: "/docs/concepts/architecture",
    cta: "Explore the SDK",
  },
  {
    name: "efferent code",
    logo: "code" as const,
    tag: "the efferent CLI",
    accent: "var(--verdigris)",
    blurb:
      "The batteries-included coding agent built on the SDK — a borderless full-screen terminal UI (and headless print / json / rpc modes), file + shell + web tools, and a persistent sub-agent fleet. One npm install.",
    points: ["TUI + print + json + rpc", "Sub-agents over a context tree", "Multi-provider, subscription or key"],
    href: "/docs/getting-started",
    cta: "Get started",
  },
]

/** The broader "one codebase" capabilities, shown as a grid. */
export const capabilities = [
  {
    title: "Multi-provider router",
    desc: "One LanguageModel port; Google / OpenAI / Anthropic / local resolved per request from your login and /model choice.",
    href: "/docs/concepts/providers",
  },
  {
    title: "Context compaction",
    desc: "Compression that never rewrites the cached prefix — a customizable policy on the agent, on by default.",
    href: "/docs/concepts/compaction",
  },
  {
    title: "Sub-agents & context tree",
    desc: "One generic run_agent tool spawns folder-scoped sub-agents; resume, branch, or hand off — every spawn persists.",
    href: "/docs/concepts/sub-agents",
  },
  {
    title: "Fleet & orchestration",
    desc: "One workspace, many sessions, one seat: fire named agent roles from a live session, attach to any of them, give the fleet a goal with a verifier, schedule with cron — fibers in one runtime.",
    href: "/docs/concepts/fleet",
  },
  {
    title: "Colocated evals",
    desc: "An Effect-native eval harness where the task can be the real agent loop — in the codebase, not bolted on.",
    href: "/docs/concepts/evals",
  },
  {
    title: "Observability",
    desc: "OpenTelemetry spans and metrics across the run — trace-first, inert until you turn export on.",
    href: "/docs/concepts/observability",
  },
  {
    title: "Skills",
    desc: "Drop markdown in .efferent/skills/ — names inject into the prompt, bodies lazy-load on demand.",
    href: "/docs/concepts/skills",
  },
]
