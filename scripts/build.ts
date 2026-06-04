#!/usr/bin/env bun
/**
 * Bundle the CLI → packages/cli/dist/efferent.js.
 *
 * Uses the Bun.build API (not the `bun build` CLI) because the TUI's Solid JSX
 * (`packages/cli/src/tui-solid/*.tsx`) needs the OpenTUI Solid babel transform,
 * and the CLI `bun build` does NOT honor bunfig `preload` plugins — only the
 * programmatic `plugins` array applies at build time. `createSolidTransformPlugin`
 * also performs solid-js's server→client entry swap so the bundled reactive
 * runtime is the universal/client build.
 *
 * `@opentui/core` is the one runtime dependency left EXTERNAL: it dlopen()s its
 * native Zig lib (`@opentui/core-<platform>/libopentui.so`) via a path resolved
 * relative to its own package location, which only works when it resolves from
 * node_modules at runtime. Everything else (@opentui/solid, solid-js, effect,
 * @effect/*) is inlined, so the dist stays a single self-contained file plus
 * that one native dependency.
 *
 * Path-independent (resolves from the script location), so it runs identically
 * from the repo root (`bun run build`) or from packages/cli (`prepublishOnly`).
 */
import { join } from "node:path"

const root = join(import.meta.dir, "..")

const result = await Bun.build({
  entrypoints: [join(root, "packages/cli/src/main.ts")],
  outdir: join(root, "packages/cli/dist"),
  naming: "efferent.js",
  target: "bun",
  external: ["@opentui/core"],
  plugins: [(await import("@opentui/solid/bun-plugin")).createSolidTransformPlugin()],
})

if (!result.success) {
  console.error("efferent build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.error(`efferent: bundled ${result.outputs.length} output → packages/cli/dist/efferent.js`)
