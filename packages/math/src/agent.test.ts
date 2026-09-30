import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { ConversationId, ConversationStore } from "@xandreed/core"
import { Harness } from "@xandreed/sdk"
import { mathAgent } from "./agent.js"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
const conversation = ConversationId.make("00000000-0000-4000-8000-00000000000a")

/** An older message database: one conversation of the workspace. */
const seed = (path: string, workspace: string) => {
  const database = new Database(path, { create: true })
  database.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, workspace_dir TEXT, title TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE messages (conversation_id TEXT NOT NULL, position INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(conversation_id, position));
  `)
  database.query("INSERT INTO conversations VALUES (?, ?, 'Earlier', 100)").run(conversation, workspace)
  database.query("INSERT INTO messages VALUES (?, 0, ?, 101)").run(conversation, JSON.stringify({ role: "user", content: "earlier prompt" }))
  database.close()
}
const messagesWith = (workspace: string, file: string) => {
  const preset = mathAgent(workspace)
  const config = { ...preset.config, plugins: preset.config.plugins.map((entry) => entry.id === "conversations" ? { ...entry, options: { ...entry.options, file } } : entry) }
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const harness = yield* Harness.make({ workspace, config, plugins: preset.plugins })
    const session = yield* harness.create()
    return yield* session.use(ConversationStore, (store) => store.list(conversation))
  })))
}

describe("math conversations", () => {
  test("the configured conversations file is the one imported into the session log", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "efferent-math-legacy-"))
    directories.push(workspace)
    mkdirSync(join(workspace, "archive"))
    seed(join(workspace, "archive", "older.db"), workspace)
    mkdirSync(join(workspace, ".efferent", "runtime"), { recursive: true })
    expect(await messagesWith(workspace, "archive/older.db")).toEqual([{ role: "user", content: "earlier prompt" }])
  })

  test("the default file is imported when none is configured", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "efferent-math-legacy-"))
    directories.push(workspace)
    mkdirSync(join(workspace, ".efferent", "runtime"), { recursive: true })
    seed(join(workspace, ".efferent/runtime/math.db"), workspace)
    expect(await messagesWith(workspace, ".efferent/runtime/math.db")).toEqual([{ role: "user", content: "earlier prompt" }])
  })
})
