import { LanguageModel } from "@effect/ai"
import { Effect, Queue, Schema, Fiber } from "effect"
import {
  ConversationId,
  ConversationStore,
  FileSystem,
  SettingsStore,
  Shell,
  coderAgentConfig,
  codingToolkitLayer,
  runAgent,
  type InstructionFile,
  type ScopedAgentConfig,
  type Skill,
} from "@agent/core"
import type { AgentEvent } from "../events.js"
import { makeEventHooks } from "../events.js"

/**
 * Minimal JSON-RPC 2.0 server over stdin/stdout (one JSON object per
 * line — newline-delimited, not LSP framing). Methods:
 *
 *   - `agent.send({ prompt, conversationId?, cwd?, allowBash? })`
 *     → starts a turn. Emits `agent.event` notifications as the loop
 *     runs. Resolves with `{ conversationId, finalText }`.
 *
 * v1 is single-request-at-a-time. Concurrent `agent.send` calls block.
 */

interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id?: number | string | null
  readonly method: string
  readonly params?: unknown
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: number | string | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: unknown
}

const writeLine = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

const decodeConversationId = Schema.decodeUnknown(ConversationId)

export interface RpcModeInput {
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly scopedAgents: ReadonlyArray<ScopedAgentConfig>
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  readonly allowBash: boolean
}

interface SendParams {
  readonly prompt?: unknown
  readonly conversationId?: unknown
  readonly cwd?: unknown
  readonly allowBash?: unknown
}

const handleSend = (
  params: SendParams,
  defaults: RpcModeInput,
  id: number | string | null,
): Effect.Effect<
  void,
  never,
  FileSystem | Shell | LanguageModel.LanguageModel | ConversationStore | SettingsStore
> =>
  Effect.gen(function* () {
    const prompt =
      typeof params.prompt === "string" ? params.prompt : ""
    if (prompt.trim() === "") {
      writeLine({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "missing 'prompt'" },
      } satisfies JsonRpcResponse)
      return
    }
    const cwd =
      typeof params.cwd === "string" ? params.cwd : defaults.cwd
    const allowBash =
      typeof params.allowBash === "boolean"
        ? params.allowBash
        : defaults.allowBash
    const rawId =
      typeof params.conversationId === "string"
        ? params.conversationId
        : crypto.randomUUID()
    const cidEither = yield* decodeConversationId(rawId).pipe(Effect.either)
    if (cidEither._tag === "Left") {
      writeLine({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `invalid 'conversationId': ${rawId}`,
        },
      } satisfies JsonRpcResponse)
      return
    }
    const cid = cidEither.right

    const queue = yield* Queue.unbounded<AgentEvent>()
    const consumer = yield* Effect.forkDaemon(
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue)
          writeLine({
            jsonrpc: "2.0",
            method: "agent.event",
            params: { conversationId: cid, event },
          } satisfies JsonRpcNotification)
        }
      }),
    )

    const hooks = makeEventHooks(queue)

    const ran = yield* runAgent(
      coderAgentConfig(
        cwd,
        defaults.skills,
        defaults.scopedAgents,
        defaults.instructionFiles,
      ),
      cid,
      prompt,
      hooks,
    ).pipe(
      Effect.provide(
        codingToolkitLayer(cwd, defaults.skills, { allowBash }),
      ),
      Effect.either,
    )

    yield* Effect.sleep("50 millis")
    yield* Fiber.interrupt(consumer)

    if (ran._tag === "Left") {
      const err = ran.left
      const msg =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err)
      writeLine({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: msg },
      } satisfies JsonRpcResponse)
      return
    }
    writeLine({
      jsonrpc: "2.0",
      id,
      result: { conversationId: cid, finalText: ran.right.finalText },
    } satisfies JsonRpcResponse)
  })

const dispatch = (
  req: JsonRpcRequest,
  defaults: RpcModeInput,
): Effect.Effect<
  void,
  never,
  FileSystem | Shell | LanguageModel.LanguageModel | ConversationStore | SettingsStore
> => {
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    writeLine({
      jsonrpc: "2.0",
      id: req.id ?? null,
      error: { code: -32600, message: "invalid request" },
    } satisfies JsonRpcResponse)
    return Effect.void
  }
  if (req.method === "agent.send") {
    return handleSend(
      (req.params ?? {}) as SendParams,
      defaults,
      req.id ?? null,
    )
  }
  writeLine({
    jsonrpc: "2.0",
    id: req.id ?? null,
    error: { code: -32601, message: `unknown method: ${req.method}` },
  } satisfies JsonRpcResponse)
  return Effect.void
}

export const runRpcMode = (
  input: RpcModeInput,
): Effect.Effect<
  void,
  never,
  FileSystem | Shell | LanguageModel.LanguageModel | ConversationStore | SettingsStore
> =>
  Effect.gen(function* () {
    // Read stdin as an async iterator of UTF-8 chunks. Bun exposes
    // `Bun.stdin.stream()`; for portability we read raw bytes via
    // ReadableStream and decode.
    const stdin = (Bun as unknown as { stdin: { stream: () => ReadableStream<Uint8Array> } }).stdin
    const decoder = new TextDecoder()
    let buffer = ""

    const reader = stdin.stream().getReader()
    const dispatcher = Effect.gen(function* () {
      while (true) {
        const { value, done } = yield* Effect.promise(() => reader.read())
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (line.length === 0) continue
          let req: JsonRpcRequest
          try {
            req = JSON.parse(line) as JsonRpcRequest
          } catch {
            writeLine({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "parse error" },
            } satisfies JsonRpcResponse)
            continue
          }
          yield* dispatch(req, input)
        }
      }
    })

    yield* dispatcher
  })
