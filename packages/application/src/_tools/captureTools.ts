import { Effect, Schema } from "effect"
import {
  type AgentTool,
  AgentToolError,
  type CaptureStore,
  type Llm,
} from "@agent/core"

import { capture } from "../Capture.js"
import { deleteCapture } from "../DeleteCapture.js"
import { getCapture } from "../GetCapture.js"
import { listCaptures } from "../ListCaptures.js"
import { saveCapture } from "../SaveCapture.js"

const wrap = (toolName: string) =>
  Effect.mapError((cause: unknown) => new AgentToolError({ tool: toolName, cause }))

// Effect's JSONSchema.make emits an `anyOf [object, array]` for empty
// Struct(), which Gemini's tool validator rejects. Override with a plain
// object schema annotation.
const ListCapturesInput = Schema.Struct({}).annotations({
  jsonSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
})
const GetCaptureInput = Schema.Struct({
  id: Schema.String.annotations({
    description: "Full UUID or unambiguous 4+ char prefix",
  }),
})
const SaveCaptureInput = Schema.Struct({
  text: Schema.String.annotations({
    description: "Raw text the user wants saved as a capture",
  }),
})
const DeleteCaptureInput = Schema.Struct({
  id: Schema.String.annotations({
    description: "Full UUID or unambiguous 4+ char prefix",
  }),
})

export const buildCaptureTools = (): ReadonlyArray<
  AgentTool<any, any, CaptureStore | Llm>
> => [
  {
    name: "list_captures",
    description:
      "List all saved captures with their id, title, and creation date. Use this to discover what's available before fetching a specific one.",
    parameters: ListCapturesInput,
    execute: () =>
      listCaptures().pipe(
        Effect.map((rows) =>
          rows.map((c) => ({
            id: c.id,
            title: c.title,
            createdAt: c.createdAt.toISOString(),
          })),
        ),
        wrap("list_captures"),
      ),
  },
  {
    name: "get_capture",
    description:
      "Fetch one capture's full body (markdown) by id. Accepts a full UUID or a 4+ char prefix.",
    parameters: GetCaptureInput,
    execute: ({ id }: { id: string }) =>
      getCapture(id).pipe(
        Effect.map((c) => ({ id: c.id, title: c.title, body: c.body })),
        wrap("get_capture"),
      ),
  },
  {
    name: "save_capture",
    description:
      "Extract structured markdown from freeform text the user pasted (e.g. a recipe, a note) and save it as a new capture. Returns the new id and inferred title.",
    parameters: SaveCaptureInput,
    execute: ({ text }: { text: string }) =>
      Effect.gen(function* () {
        const extracted = yield* capture({ text })
        const saved = yield* saveCapture({
          title: extracted.title,
          body: extracted.body,
          source: "agent",
        })
        return { id: saved.id, title: saved.title }
      }).pipe(wrap("save_capture")),
  },
  {
    name: "delete_capture",
    description: "Delete a capture by id (full UUID or 4+ char prefix).",
    parameters: DeleteCaptureInput,
    execute: ({ id }: { id: string }) =>
      deleteCapture(id).pipe(
        Effect.as({ ok: true, id }),
        wrap("delete_capture"),
      ),
  },
]
