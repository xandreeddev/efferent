import { Effect, Layer, Ref, Schema } from "effect"
import {
  type AgentMessage,
  type Checkpoint,
  ConversationId,
  ConversationNotFound,
  ConversationStore,
  ConversationStoreError,
} from "@xandreed/sdk-core"

/**
 * An in-memory `ConversationStore` for evals — no Postgres, no Docker. It
 * mirrors the production adapter's position/checkpoint fold semantics exactly
 * (see `packages/adapters/src/conversationStore/postgres.ts`) so `runAgent`
 * and `createHandoff` behave identically:
 *   - `append` assigns `position = max(position) + 1` (0 for the first row).
 *   - `checkpoint` records `messagePosition = max(position)` (or -1 if empty).
 *   - `listActive` returns rows with `position > latestCheckpoint.position`
 *     (all rows if there's no checkpoint).
 */

interface Stored {
  readonly position: number
  readonly msg: AgentMessage
}

interface Conv {
  readonly createdAt: number
  readonly workspaceDir?: string
  readonly title?: string
  readonly model?: string
  readonly pendingPrompt?: string
  readonly messages: ReadonlyArray<Stored>
  readonly checkpoints: ReadonlyArray<Checkpoint>
}

const maxPosition = (conv: Conv): number =>
  conv.messages.reduce((max, m) => (m.position > max ? m.position : max), -1)

const latestCheckpoint = (conv: Conv): Checkpoint | undefined =>
  conv.checkpoints.length === 0 ? undefined : conv.checkpoints[conv.checkpoints.length - 1]

export const InMemoryConversationStoreLive = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const ref = yield* Ref.make(new Map<string, Conv>())

    const decodeId = (raw: string) =>
      Schema.decodeUnknown(ConversationId)(raw).pipe(
        Effect.mapError(
          (cause) => new ConversationStoreError({ cause, message: "Invalid ConversationId" }),
        ),
      )

    const getConv = (id: ConversationId) => Ref.get(ref).pipe(Effect.map((m) => m.get(id)))

    return ConversationStore.of({
      create: (workspaceDir) =>
        Effect.gen(function* () {
          const id = yield* decodeId(crypto.randomUUID())
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(id, {
              createdAt: Date.now(),
              ...(workspaceDir !== undefined ? { workspaceDir } : {}),
              messages: [],
              checkpoints: [],
            })
            return next
          })
          return id
        }),

      ensure: (id, workspaceDir) =>
        Ref.update(ref, (m) => {
          if (m.has(id)) return m
          const next = new Map(m)
          next.set(id, {
            createdAt: Date.now(),
            ...(workspaceDir !== undefined ? { workspaceDir } : {}),
            messages: [],
            checkpoints: [],
          })
          return next
        }),

      append: (id, msg) =>
        Effect.gen(function* () {
          const conv = yield* getConv(id)
          if (conv === undefined) {
            return yield* Effect.fail(new ConversationNotFound({ id }))
          }
          const position = maxPosition(conv) + 1
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(id, { ...conv, messages: [...conv.messages, { position, msg }] })
            return next
          })
          return position
        }),

      list: (id) =>
        getConv(id).pipe(
          Effect.map((conv) =>
            conv === undefined ? [] : conv.messages.map((s) => s.msg),
          ),
        ),

      checkpoint: (id, summary) =>
        Effect.gen(function* () {
          const conv = yield* getConv(id)
          if (conv === undefined) return
          const checkpoint: Checkpoint = {
            id: crypto.randomUUID(),
            conversationId: id,
            messagePosition: maxPosition(conv),
            summary,
            createdAt: Date.now(),
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(id, { ...conv, checkpoints: [...conv.checkpoints, checkpoint] })
            return next
          })
        }),

      getLatestCheckpoint: (id) =>
        getConv(id).pipe(Effect.map((conv) => (conv === undefined ? undefined : latestCheckpoint(conv)))),

      listCheckpoints: (id) =>
        getConv(id).pipe(
          Effect.map((conv) =>
            conv === undefined
              ? []
              : [...conv.checkpoints].sort((a, b) => a.messagePosition - b.messagePosition),
          ),
        ),

      listActive: (id) =>
        getConv(id).pipe(
          Effect.map((conv) => {
            if (conv === undefined) return []
            const cp = latestCheckpoint(conv)
            const rows =
              cp === undefined
                ? conv.messages
                : conv.messages.filter((s) => s.position > cp.messagePosition)
            return rows.map((s) => s.msg)
          }),
        ),

      setTitle: (id, title) =>
        Effect.gen(function* () {
          const conv = yield* getConv(id)
          if (conv === undefined) {
            return yield* Effect.fail(new ConversationNotFound({ id }))
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(id, { ...conv, title })
            return next
          })
        }),

      listByWorkspace: (workspaceDir) =>
        Ref.get(ref).pipe(
          Effect.map((m) =>
            [...m.entries()]
              .filter(([, conv]) => conv.workspaceDir === workspaceDir)
              .sort(([, a], [, b]) => b.createdAt - a.createdAt)
              .map(([id, conv]) => {
                const firstUser = conv.messages.find((s) => s.msg.role === "user")?.msg
                const firstPrompt =
                  firstUser !== undefined && firstUser.role === "user" ? firstUser.content : undefined
                return {
                  id: id as ConversationId,
                  createdAt: conv.createdAt,
                  ...(firstPrompt !== undefined ? { firstPrompt } : {}),
                  ...(conv.title !== undefined ? { title: conv.title } : {}),
                  ...(conv.model !== undefined ? { model: conv.model } : {}),
                }
              }),
          ),
        ),

      setModel: (id, model) =>
        Effect.gen(function* () {
          const conv = yield* getConv(id)
          if (conv === undefined) {
            return yield* Effect.fail(new ConversationNotFound({ id }))
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(id, { ...conv, model })
            return next
          })
        }),

      markPending: (id, prompt) =>
        Effect.gen(function* () {
          const conv = yield* getConv(id)
          if (conv === undefined) {
            return yield* Effect.fail(new ConversationNotFound({ id }))
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(id, { ...conv, pendingPrompt: prompt })
            return next
          })
        }),

      clearPending: (id) =>
        Ref.update(ref, (m) => {
          const conv = m.get(id)
          if (conv === undefined) return m
          const next = new Map(m)
          const { pendingPrompt: _drop, ...rest } = conv
          next.set(id, rest)
          return next
        }),

      listPending: (workspaceDir) =>
        Ref.get(ref).pipe(
          Effect.map((m) =>
            [...m.entries()]
              .filter(([, conv]) => conv.workspaceDir === workspaceDir && conv.pendingPrompt !== undefined)
              .map(([id, conv]) => ({ id: id as ConversationId, prompt: conv.pendingPrompt ?? "" })),
          ),
        ),

    })
  }),
)
