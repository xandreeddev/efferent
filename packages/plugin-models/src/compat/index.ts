// `@xandreed/plugin-models/compat`: effect/ai's `LanguageModel` over an
// OpenAI-compatible chat-completions endpoint, and the prompt conversion it
// sends (a route that reads no images gets their label lines).
export { makeCompatLanguageModel, promptWithImageLabels, toChatMessages } from "../llm/compat.js"
export type { ChatMessageOptions, CompatConfig } from "../llm/compat.js"
