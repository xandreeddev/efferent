# @agent/web

Placeholder. Do not flesh out until the CLI slice has shipped at least one post-worthy artifact.

## When this gets built

- HTTP server on Bun via `@effect/platform-bun`.
- htmx for interactions, Server-Sent Events for streaming model output. No React.
- ETA or typed template strings for rendering.
- Same composition-root rule as `@agent/cli`: route handlers call `@agent/application` use cases; layers (adapters + `BunContext`) are provided at the edge.
- If a use case applies to both CLI and web, it lives in `@agent/application` unchanged — drivers are interchangeable consumers.
