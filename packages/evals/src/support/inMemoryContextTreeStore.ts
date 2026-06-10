import { Effect, Layer, Ref, Schema } from "effect"
import {
  type AgentContextNode,
  type AgentMessage,
  ContextNodeId,
  ContextNodeNotFound,
  ContextTreeStore,
  ContextTreeStoreError,
} from "@efferent/core"

/**
 * In-memory `ContextTreeStore` for evals/unit tests — no SQL, no Docker. Mirrors
 * the production adapters' semantics: `spawn` materializes the seed messages,
 * `append` adds to the node's own history, `recordReturn` closes the node,
 * `listTree` filters by `rootConversationId`, and `drop` removes a node plus its
 * descendants.
 */

interface Entry {
  readonly node: AgentContextNode
  readonly messages: ReadonlyArray<AgentMessage>
}

export const InMemoryContextTreeStoreLive = Layer.effect(
  ContextTreeStore,
  Effect.gen(function* () {
    const ref = yield* Ref.make(new Map<string, Entry>())

    const decodeId = (raw: string) =>
      Schema.decodeUnknown(ContextNodeId)(raw).pipe(
        Effect.mapError(
          (cause) =>
            new ContextTreeStoreError({ cause, message: "Invalid ContextNodeId" }),
        ),
      )

    const getEntry = (id: ContextNodeId) =>
      Ref.get(ref).pipe(Effect.map((m) => m.get(id)))

    return ContextTreeStore.of({
      spawn: (input) =>
        Effect.gen(function* () {
          const id = yield* decodeId(crypto.randomUUID())
          const node: AgentContextNode = {
            id,
            parentId: input.parentId,
            rootConversationId: input.rootConversationId,
            edgeKind: input.edgeKind,
            folder: input.folder,
            displayRoot: input.displayRoot,
            seed: input.seed,
            seedMessageCount: input.seedMessages.length,
            status: "running",
            filesChanged: [],
            createdAt: Date.now(),
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(id, { node, messages: [...input.seedMessages] })
            return next
          })
          return id
        }),

      append: (id, msg) =>
        Effect.gen(function* () {
          const entry = yield* getEntry(id)
          if (entry === undefined) {
            return yield* Effect.fail(new ContextNodeNotFound({ id }))
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(id, { ...entry, messages: [...entry.messages, msg] })
            return next
          })
        }),

      listMessages: (id) =>
        getEntry(id).pipe(Effect.map((e) => (e === undefined ? [] : e.messages))),

      recordReturn: (id, result) =>
        Effect.gen(function* () {
          const entry = yield* getEntry(id)
          if (entry === undefined) {
            return yield* Effect.fail(new ContextNodeNotFound({ id }))
          }
          const node: AgentContextNode = {
            ...entry.node,
            status: result.status,
            returnSummary: result.summary,
            filesChanged: result.filesChanged,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            ...(result.workspaceRef !== undefined ? { workspaceRef: result.workspaceRef } : {}),
            endedAt: Date.now(),
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(id, { ...entry, node })
            return next
          })
        }),

      get: (id) =>
        Effect.gen(function* () {
          const entry = yield* getEntry(id)
          if (entry === undefined) {
            return yield* Effect.fail(new ContextNodeNotFound({ id }))
          }
          return entry.node
        }),

      listTree: (rootConversationId) =>
        Ref.get(ref).pipe(
          Effect.map((m) =>
            [...m.values()]
              .map((e) => e.node)
              .filter((n) => n.rootConversationId === rootConversationId)
              .sort((a, b) => a.createdAt - b.createdAt),
          ),
        ),

      drop: (id) =>
        Ref.update(ref, (m) => {
          const toDelete = new Set<string>()
          const collect = (nid: string) => {
            toDelete.add(nid)
            for (const e of m.values()) {
              if (e.node.parentId === nid) collect(e.node.id)
            }
          }
          collect(id)
          const next = new Map(m)
          for (const d of toDelete) next.delete(d)
          return next
        }),
    })
  }),
)
