// `@xandreed/plugin-models/testing`: a scripted OpenAI-compatible
// chat-completions endpoint, in the process, for tests and evaluations that
// run the production compat client with no key and no network.
export { scriptedChatCompletions } from "../transport/scripted-chat.adapter.js"
export type { ScriptedChatCompletions } from "../transport/scripted-chat.adapter.js"
export { SCRIPTED_CHUNK_SIZE, ScriptedFinishReason, ScriptedReply, ScriptedText, ScriptedToolCall, ScriptedUsage } from "../transport/scripted-chat.entity.js"
export type { ScriptedRequest, ScriptedRequestRecord, ScriptedStep } from "../transport/scripted-chat.entity.js"
