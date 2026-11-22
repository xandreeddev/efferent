import type { Prompt, Response } from "effect/ai"

/**
 * A part of an answer's thinking as the provider gave it: its text (which may be empty: a provider may send only a
 * signature) and the provider's metadata, sent back as the part's options. The metadata is opaque here: it names no
 * provider.
 */
export interface Thought {
  readonly id: string
  readonly text: string
  readonly options: Response.ProviderMetadata
}

/**
 * The thinking a streamed answer gave, folded from its parts: each `reasoning-start` opens a thought, each
 * `reasoning-delta` adds its text and merges its metadata (a signature comes in a delta of no text), in the order the
 * thoughts began. A thought that carries no metadata is left out: with nothing of the provider's to show it is the
 * provider's own, it cannot be sent back as one.
 */
export const thoughtsOf = (parts: ReadonlyArray<Response.AnyPart>): ReadonlyArray<Thought> => {
  const thoughts: Array<{ id: string; text: string; options: Response.ProviderMetadata }> = []
  for (const part of parts) {
    if (part.type === "reasoning-start") thoughts.push({ id: part.id, text: "", options: {} })
    if (part.type === "reasoning-delta") {
      const thought = thoughts.findLast((one) => one.id === part.id)
      if (thought !== undefined) {
        thought.text += part.delta
        thought.options = { ...thought.options, ...part.metadata }
      }
    }
  }
  return thoughts.filter((thought) => Object.keys(thought.options).length > 0)
}

/**
 * The context with each answer's thinking put back at the start of its parts, as the provider gave it: an answer is
 * known by its first call's id (an answer with no call is a turn's last words or a closing call's, which no later
 * request of the tool loop needs the thinking of). A context with no thoughts kept is returned as it is.
 */
export const withThoughts = (
  context: ReadonlyArray<Prompt.MessageEncoded>,
  thoughts: ReadonlyMap<string, ReadonlyArray<Thought>>,
): ReadonlyArray<Prompt.MessageEncoded> => {
  if (thoughts.size === 0) return context
  return context.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") return message
    const first = message.content.find((part) => part.type === "tool-call")
    const kept = first === undefined ? undefined : thoughts.get(first.id)
    if (kept === undefined) return message
    const reasoning: ReadonlyArray<Prompt.ReasoningPartEncoded> = kept.map((thought) => ({ type: "reasoning", text: thought.text, options: thought.options }))
    return { ...message, content: [...reasoning, ...message.content] }
  })
}
