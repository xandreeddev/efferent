import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { SqliteConversationStoreLive } from "@xandreed/providers"
import { SqliteUiComponentCatalogLive } from "./sqlite-ui-component-catalog.adapter.js"
import { SqliteUiPageStoreLive } from "./sqlite-ui-page-store.adapter.js"
import { SqliteUiThemeStoreLive } from "./sqlite-ui-theme-store.adapter.js"

const storeStack = (dbPath: string) => Layer.mergeAll(
  SqliteConversationStoreLive(dbPath),
  SqliteUiPageStoreLive(dbPath),
  SqliteUiComponentCatalogLive(dbPath),
  SqliteUiThemeStoreLive(dbPath),
)

const buildAndCloseStoreStack = Effect.acquireUseRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "canvas-store-stack-"))),
  (dir) => Effect.scoped(Layer.build(storeStack(join(dir, "canvas.db")))).pipe(
    Effect.map((services) => ({ dir, services })),
  ),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

describe("the Canvas SQLite store stack", () => {
  test("parallel stacks initialize and close without racing shared WAL setup", async () => {
    const results = await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: 12 }),
        () => buildAndCloseStoreStack,
        { concurrency: 6 },
      ),
    )

    expect(results).toHaveLength(12)
    expect(results.every(({ dir }) => !existsSync(dir))).toBe(true)
  })
})
