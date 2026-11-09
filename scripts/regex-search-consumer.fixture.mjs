import assert from "node:assert/strict"
import { Context, Effect, Schema } from "effect"
import { FileSystem, makeMemoryFileSystem, SessionEnvironment } from "@xandreed/core"
import { GrepResult, workspaceTools, workspaceToolsDefaults } from "@xandreed/plugin-workspace"

const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fs = yield* makeMemoryFileSystem()
  yield* fs.mkdir("/workspace", { recursive: true })
  yield* fs.write("/workspace/slow.txt", "a".repeat(100) + "!")
  yield* fs.write("/workspace/plain.txt", "fixture text")
  const tools = yield* workspaceTools({ ...workspaceToolsDefaults, grepEngine: "builtin", tools: ["grep"], grepTimeoutMs: 1000 })
  const tool = tools.tools.find((entry) => entry.tool.name === "grep")
  assert.ok(tool)
  const context = Context.make(FileSystem, fs).pipe(Context.add(SessionEnvironment, { workspace: "/workspace" }))
  const search = (params) => tool.handler(params).pipe(Effect.provide(context), Effect.flatMap(Schema.decodeUnknownEffect(GrepResult)))
  const bounded = yield* search({ path: "slow.txt", pattern: "(a|aa)+$" })
  assert.equal(bounded.timedOut, true)
  assert.equal(bounded.truncated, true)
  const literal = yield* search({ path: "slow.txt", pattern: "a", literal: true })
  assert.equal(literal.matches, 1)
  const ordinary = yield* search({ path: "plain.txt", pattern: "fixture" })
  assert.equal(ordinary.matches, 1)
  assert.equal(ordinary.timedOut, false)
  return { runtime: typeof Bun === "undefined" ? "Node" : "Bun", bounded: true, literal: true, ordinary: true }
})).pipe(Effect.timeout("10 seconds")))
console.log(`regex-search ${JSON.stringify(result)}`)
