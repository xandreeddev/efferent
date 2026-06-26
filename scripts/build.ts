#!/usr/bin/env bun
/**
 * Bundle the efferent CLI → packages/cli/dist/efferent.js.
 *
 * Uses the Bun.build API (not the `bun build` CLI) because the TUI's Solid JSX
 * (`packages/cli/src/cli/*.tsx`) needs the OpenTUI Solid babel transform,
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

/**
 * Stub out the provider tokenizer packages. `@effect/ai-anthropic` /
 * `@effect/ai-openai` statically import `@anthropic-ai/tokenizer` /
 * `gpt-tokenizer` for their optional `Tokenizer` service, which efferent never
 * uses (token counts come from provider usage metadata). Left in, they cost
 * ~3MB of inlined BPE vocab AND break the published bundle two ways: tiktoken's
 * CJS shim bakes this machine's absolute build path into the artifact (a
 * privacy leak), and its wasm loader readFileSync()s at module-init — on a
 * machine without tiktoken in node_modules that's a crash at startup.
 */
const tokenizerStub: Bun.BunPlugin = {
  name: "stub-tokenizers",
  setup(build) {
    build.onResolve({ filter: /^@anthropic-ai\/tokenizer$|^gpt-tokenizer$/ }, (args) => ({
      path: args.path,
      namespace: "tokenizer-stub",
    }))
    build.onLoad({ filter: /.*/, namespace: "tokenizer-stub" }, () => ({
      contents: `const unavailable = () => { throw new Error("tokenizers are not bundled with efferent (the CLI never tokenizes locally)") }
export const getTokenizer = unavailable
export const countTokens = unavailable
export const encode = unavailable
export const decode = unavailable
export default { getTokenizer: unavailable, countTokens: unavailable, encode: unavailable, decode: unavailable }
`,
      loader: "js",
    }))
  },
}

const result = await Bun.build({
  entrypoints: [join(root, "packages/cli/src/main.ts")],
  outdir: join(root, "packages/cli/dist"),
  naming: "efferent.js",
  target: "bun",
  // `@opentui/core` dlopen()s its native lib from its own package dir, so it
  // must resolve from node_modules at runtime (see above). `msgpackr-extract`
  // is the OPTIONAL native accelerator for `msgpackr` (a transitive
  // @effect/platform dep): inlining it bakes the build machine's absolute
  // `__dirname` into the artifact (the same leak class as the tokenizers), and
  // msgpackr already wraps the `require` in a try/catch and falls back to pure
  // JS when it's absent — so we leave it external (no path baked; JS fallback
  // in the published bundle, native accel preserved when running from source).
  external: ["@opentui/core", "msgpackr-extract"],
  plugins: [
    tokenizerStub,
    (await import("@opentui/solid/bun-plugin")).createSolidTransformPlugin(),
  ],
})

if (!result.success) {
  console.error("efferent build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.error(
  `efferent: bundled ${result.outputs.length} output → packages/cli/dist/efferent.js`,
)
