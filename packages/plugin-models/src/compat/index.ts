// `@xandreed/plugin-models/compat`: effect/ai's `LanguageModel` over an
// OpenAI-compatible chat-completions endpoint, and the prompt conversion it
// sends (a route that reads no images gets their label lines), with the
// spend guard its sends can reserve and settle with.
export { makeCompatLanguageModel, promptWithImageLabels, toChatMessages } from "../llm/compat.js"
export type { ChatMessageOptions, CompatConfig } from "../llm/compat.js"
export type { ModelSpendGuard } from "../ports/model-spend-guard.port.js"
