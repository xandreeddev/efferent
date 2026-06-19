// @ts-check
import { fileURLToPath } from "node:url"
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"

// The repo root (one level above website/) — example sources live there and are
// rendered into the docs via `?raw`, so Vite must be allowed to read them.
const repoRoot = fileURLToPath(new URL("..", import.meta.url))

// Project page under the github.io subdomain: https://xandreeddev.github.io/efferent/
// `base` must match the repo name so every nav/asset link is prefixed correctly.
export default defineConfig({
  site: "https://xandreeddev.github.io",
  base: "/efferent",
  vite: {
    server: { fs: { allow: [repoRoot] } },
  },
  integrations: [
    starlight({
      title: "efferent",
      description:
        "A coding-agent SDK on Effect.ts + Bun — ports & adapters, an @effect/ai toolkit, a multi-provider router, cache-safe context compression, and a persistent sub-agent tree.",
      logo: {
        src: "./src/assets/efferent-mark.svg",
        alt: "efferent",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/xandreeddev/efferent",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/xandreeddev/efferent/edit/main/website/",
      },
      customCss: [
        "@fontsource-variable/hanken-grotesk",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/efferent.css",
      ],
      expressiveCode: {
        themes: ["github-dark", "github-light"],
        styleOverrides: {
          borderRadius: "0.4rem",
          codeFontFamily: "var(--sl-font-mono)",
        },
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Introduction", slug: "index" },
            { label: "Getting started", slug: "getting-started" },
            { label: "Your first agent", slug: "your-first-agent" },
          ],
        },
        {
          label: "Concepts",
          items: [{ autogenerate: { directory: "concepts" } }],
        },
        {
          label: "Guides",
          items: [{ autogenerate: { directory: "guides" } }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
        {
          label: "Examples",
          items: [{ autogenerate: { directory: "examples" } }],
        },
      ],
    }),
  ],
})
