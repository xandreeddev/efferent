// @ts-check
import { fileURLToPath } from "node:url"
import { defineConfig } from "astro/config"
import mdx from "@astrojs/mdx"
import sitemap from "@astrojs/sitemap"
import remarkDirective from "remark-directive"
import remarkCallouts from "./src/plugins/remark-callouts.mjs"
import rehypeBaseLinks from "./src/plugins/rehype-base-links.mjs"

// Project page under the github.io subdomain: https://xandreeddev.github.io/efferent/
const BASE = "/efferent"

// The repo root (one level above website/) — example sources are rendered into the
// docs via `?raw`, so Vite must be allowed to read them.
const repoRoot = fileURLToPath(new URL("..", import.meta.url))

export default defineConfig({
  site: "https://xandreeddev.github.io",
  base: BASE,
  trailingSlash: "ignore",
  vite: {
    server: { fs: { allow: [repoRoot] } },
  },
  integrations: [mdx(), sitemap()],
  markdown: {
    remarkPlugins: [remarkDirective, remarkCallouts],
    rehypePlugins: [[rehypeBaseLinks, { base: BASE }]],
    shikiConfig: {
      // One dark theme for all code (both site themes) — a consistent terminal
      // look; the warm background is applied in CSS over Shiki's token colours.
      theme: "one-dark-pro",
      wrap: false,
    },
  },
})
