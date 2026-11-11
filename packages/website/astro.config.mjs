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

// The repo root (two levels above packages/website/) — example sources are rendered
// into the docs via `?raw`, so Vite must be allowed to read them.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

const shim = (name) => fileURLToPath(new URL(`./src/learn/shims/${name}`, import.meta.url))

export default defineConfig({
  site: "https://xandreeddev.github.io",
  base: BASE,
  trailingSlash: "ignore",
  vite: {
    server: { fs: { allow: [repoRoot] } },
    // The learn playground runs the real framework in the page. Its packages
    // import three Node modules; the browser gets small stand-ins (src/learn/shims).
    resolve: {
      alias: [
        { find: /^node:crypto$/, replacement: shim("node-crypto.ts") },
        { find: /^node:os$/, replacement: shim("node-os.ts") },
        { find: /^node:process$/, replacement: shim("node-process.ts") },
      ],
      dedupe: ["effect"],
    },
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
