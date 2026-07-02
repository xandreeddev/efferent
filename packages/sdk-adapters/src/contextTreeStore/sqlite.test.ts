import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  type AgentMessage,
  type ContextNodeId,
  ContextTreeStore,
} from "@xandreed/sdk-core"
import { SqliteContextTreeStoreLive } from "./sqlite.js"
import sqlite0001 from "../database/migrations-sqlite/0001_init.js"
import sqlite0002 from "../database/migrations-sqlite/0002_context_tree.js"
import sqlite0003 from "../database/migrations-sqlite/0003_workspace_ref.js"
import sqlite0004 from "../database/migrations-sqlite/0004_seed_count.js"
import sqlite0006 from "../database/migrations-sqlite/0006_node_title.js"
import sqlite0009 from "../database/migrations-sqlite/0009_node_kind.js"
import sqlite0010 from "../database/migrations-sqlite/0010_node_outcome.js"

// Exercises the REAL SQLite context-tree store (the unit suites elsewhere use
// the in-memory store, which never touches SQL). A fresh in-memory db per run;
// we run the migrations directly on the connection (avoiding the migrator's
// platform FileSystem requirement), exactly as the conversation store test does.
const Live = SqliteContextTreeStoreLive.pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
)

const user = (content: string): AgentMessage => ({ role: "user", content })

const run = <A>(eff: Effect.Effect<A, unknown, ContextTreeStore>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* sqlite0001 // conversations/messages/checkpoints (not used here, realistic order)
      yield* sqlite0002 // context_nodes + context_messages
      yield* sqlite0003 // + workspace_ref staleness stamp
      yield* sqlite0004 // + seed_message_count boundary stamp
      yield* sqlite0006 // + the spawner-given display title
      yield* sqlite0009 // + the explicit fleet/agent node kind
      yield* sqlite0010 // + the honest-outcome stop_reason column
      return yield* eff
    }).pipe(Effect.provide(Live)) as Effect.Effect<A>,
  )

const spawnRoot = (folder: string, seedMessages: ReadonlyArray<AgentMessage>) =>
  Effect.gen(function* () {
    const store = yield* ContextTreeStore
    return yield* store.spawn({
      parentId: null,
      rootConversationId: null,
      edgeKind: "spawned",
      folder,
      displayRoot: "/tmp/ws",
      seed: { kind: "task", preview: folder },
      seedMessages,
    })
  })

describe("SqliteContextTreeStore", () => {
  test("spawn materializes the seed; get reports a running node", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ContextTreeStore
        const id = yield* spawnRoot("/tmp/ws/adapters", [user("add the store")])
        return { node: yield* store.get(id), messages: yield* store.listMessages(id) }
      }),
    )
    expect(result.node.status).toBe("running")
    expect(result.node.folder).toBe("/tmp/ws/adapters")
    expect(result.node.seed.kind).toBe("task")
    expect(result.node.seedMessageCount).toBe(1)
    expect(result.messages.map((m) => (m.role === "user" ? m.content : ""))).toEqual(["add the store"])
  })

  test("spawn persists the display title; untitled rows omit it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ContextTreeStore
        const titled = yield* store.spawn({
          parentId: null,
          rootConversationId: null,
          edgeKind: "spawned",
          folder: "/tmp/ws/tui",
          displayRoot: "/tmp/ws",
          title: "audit state layer",
          seed: { kind: "task" },
          seedMessages: [user("t")],
        })
        const untitled = yield* spawnRoot("/tmp/ws/tui", [user("t")])
        return { titled: yield* store.get(titled), untitled: yield* store.get(untitled) }
      }),
    )
    expect(result.titled.title).toBe("audit state layer")
    expect(result.untitled.title).toBeUndefined()
  })

  test("spawn stamps the SESSION→FLEET→AGENT kind: a root is a fleet, a child an agent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ContextTreeStore
        const root = yield* spawnRoot("/root", [user("a")])
        const child = yield* store.spawn({
          parentId: root,
          rootConversationId: null,
          edgeKind: "spawned",
          folder: "/root/child",
          displayRoot: "/tmp/ws",
          seed: { kind: "task" },
          seedMessages: [user("b")],
        })
        return { root: yield* store.get(root), child: yield* store.get(child) }
      }),
    )
    expect(result.root.kind).toBe("fleet")
    expect(result.child.kind).toBe("agent")
  })

  test("append grows the node's history in order", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ContextTreeStore
        const id = yield* spawnRoot("/f", [user("seed")])
        yield* store.append(id, user("a"))
        yield* store.append(id, user("b"))
        return yield* store.listMessages(id)
      }),
    )
    expect(result.map((m) => (m.role === "user" ? m.content : ""))).toEqual(["seed", "a", "b"])
  })

  test("recordReturn closes the node with summary/files/usage", async () => {
    const node = await run(
      Effect.gen(function* () {
        const store = yield* ContextTreeStore
        const id = yield* spawnRoot("/f", [user("seed")])
        yield* store.recordReturn(id, {
          status: "ok",
          summary: "did the thing",
          filesChanged: ["a.ts", "b.ts"],
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 },
          workspaceRef: "abc123def",
        })
        return yield* store.get(id)
      }),
    )
    expect(node.status).toBe("ok")
    expect(node.returnSummary).toBe("did the thing")
    expect(node.filesChanged).toEqual(["a.ts", "b.ts"])
    expect(node.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 })
    expect(node.workspaceRef).toBe("abc123def")
    expect(typeof node.endedAt).toBe("number")
  })

  test("branch seeds a child from a finished node's resulting messages", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ContextTreeStore
        const parent = yield* spawnRoot("/f", [user("seed")])
        yield* store.append(parent, user("parent work"))
        yield* store.recordReturn(parent, { status: "ok", summary: "done", filesChanged: [] })
        const parentMsgs = yield* store.listMessages(parent)
        const child = yield* store.spawn({
          parentId: parent,
          rootConversationId: null,
          edgeKind: "branched",
          folder: "/f",
          displayRoot: "/tmp/ws",
          seed: { kind: "selection", sourceNodeId: parent, turnCount: parentMsgs.length },
          seedMessages: parentMsgs,
        })
        return {
          childNode: yield* store.get(child),
          childMsgs: yield* store.listMessages(child),
          parentMsgs,
        }
      }),
    )
    expect(result.childNode.edgeKind).toBe("branched")
    expect(result.childNode.parentId).not.toBeNull()
    expect(result.childNode.seedMessageCount).toBe(result.parentMsgs.length)
    expect(result.childMsgs.map((m) => (m.role === "user" ? m.content : ""))).toEqual(
      result.parentMsgs.map((m) => (m.role === "user" ? m.content : "")),
    )
  })

  test("resume continues the same node (no new node)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ContextTreeStore
        const id = yield* spawnRoot("/f", [user("seed")])
        yield* store.recordReturn(id, { status: "ok", summary: "v1", filesChanged: [] })
        yield* store.append(id, user("more work"))
        return {
          msgs: yield* store.listMessages(id),
          tree: yield* store.listTree(null),
        }
      }),
    )
    expect(result.msgs.map((m) => (m.role === "user" ? m.content : ""))).toEqual(["seed", "more work"])
    expect(result.tree).toHaveLength(1)
  })

  test("listTree reconstructs parent/child structure", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ContextTreeStore
        const root = yield* spawnRoot("/root", [user("a")])
        const child = yield* store.spawn({
          parentId: root,
          rootConversationId: null,
          edgeKind: "spawned",
          folder: "/root/child",
          displayRoot: "/tmp/ws",
          seed: { kind: "task" },
          seedMessages: [user("b")],
        })
        const tree = yield* store.listTree(null)
        return { tree, root, child }
      }),
    )
    expect(result.tree).toHaveLength(2)
    const childNode = result.tree.find((n) => n.id === result.child)!
    expect(childNode.parentId).toBe(result.root)
    const rootNode = result.tree.find((n) => n.id === result.root)!
    expect(rootNode.parentId).toBeNull()
  })

  test("drop removes a node and its descendants (recursive CTE)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ContextTreeStore
        const root = yield* spawnRoot("/root", [user("a")])
        const child: ContextNodeId = yield* store.spawn({
          parentId: root,
          rootConversationId: null,
          edgeKind: "spawned",
          folder: "/root/child",
          displayRoot: "/tmp/ws",
          seed: { kind: "task" },
          seedMessages: [user("b")],
        })
        yield* store.drop(root)
        const remaining = yield* store.listTree(null)
        const childExit = yield* Effect.exit(store.get(child))
        return { remaining, childGone: childExit._tag === "Failure" }
      }),
    )
    expect(result.remaining).toHaveLength(0)
    expect(result.childGone).toBe(true)
  })
})
