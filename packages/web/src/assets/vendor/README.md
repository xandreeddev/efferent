# Vendored assets — pinned, never edited

| file | package | version | sha256 (body, before our header line) |
|---|---|---|---|
| `htmx.min.js` | `htmx.org` | 2.0.7 | `60231ae6ba9db3825eb15a261122d5f55921c4d53b66bf637dc18b4ee27c79f9` |
| `htmx-ext-ws.js` | `htmx-ext-ws` | 2.0.4 | `896afc2936ded7a56373edf16ce75b0fe9bf49c03d1f55aee9baa94cb87c8d3e` |
| `mermaid.min.js` | `mermaid` | 11.12.2 | `d0830a6c05546e9edb8fe20a8f545f3e0dc7c4c3134d584bad9c13a99d7a71e0` (no header line — 2.75 MB, kept byte-identical) |

Source: `https://unpkg.com/<package>@<version>/dist/…` (mermaid via jsdelivr, same dist file). To
upgrade: download the new dist file, prepend the one-line header comment with the new sha256 of
the body (mermaid excepted — too large to reflow, the table row is its record), update this table,
and keep the two htmx files' major versions in lockstep (the ws extension must match htmx's major).
`mermaid.min.js` is the single-file browser IIFE (`globalThis.mermaid`) — it is served lazily
(`diagrams.js` injects the script tag on the first diagram), so its parse cost is paid only when
a page actually contains one.

The sibling `.d.ts` files exist so TypeScript accepts the Bun text-import
(`import src from "./htmx.min.js" with { type: "text" }`); Bun (runtime and `Bun.build`) inlines
the file content as a string.
