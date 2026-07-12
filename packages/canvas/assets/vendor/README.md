# Vendored assets — pinned, never edited

| file | package | version | sha256 |
|---|---|---|---|
| `htmx.min.js` | `htmx.org` | 2.0.7 | `ec4d5660d1bf3e020afcc3759c90979329fe81789eeaca44bf811024b7d660b1` |
| `htmx-ext-ws.js` | `htmx-ext-ws` | 2.0.4 | `db0c05d0e97e57215050063cc0a71b3d7c60f01169c83d8c6f542f4f72165dd8` |
| `alpine.min.js` | `@alpinejs/csp` | 3.15.12 | `566167134bb2347110904e2ced6e816d2e8d837200c158f98b72372b3bb0b9a6` |

Source: the pinned workspace packages' production distributions. To upgrade,
copy the new minified distribution, update its sha256 here, and keep the two
htmx files' major versions in lockstep.

There is deliberately no Tailwind or Mermaid browser runtime. Trusted recipe
CSS is precompiled and typed graphs render to accessible SVG on the server.
Alpine uses the CSP build, so the shell does not need `unsafe-eval`.
