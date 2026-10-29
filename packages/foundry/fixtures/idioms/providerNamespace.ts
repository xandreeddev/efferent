const metadata: Readonly<Record<string, unknown>> = {}

export const written = { anthropic: { signature: "s" } }
export const quoted = { "openai": { itemId: "i" }, ["google"]: {} }
export const read = metadata.router
export const indexed = metadata["anthropic"]
export const { openai } = metadata
export interface Options { readonly google?: unknown }
export const engine = { engine: { model: "anthropic:claude" } }
export const providers = ["anthropic", "openai", "google", "router"]
export const tagged = { provider: "anthropic" }
export const router = (key: string) => metadata[key]
