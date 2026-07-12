import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const dashboard = (name: string): string =>
  readFileSync(
    join(import.meta.dir, "..", "..", "..", "observability", "grafana", "dashboards", "production", name),
    "utf-8",
  )

describe("new-line telemetry contract", () => {
  test("conversation dashboards query emitted agent/engine spans", () => {
    const all = dashboard("conversations.json")
    const one = dashboard("conversation.json")
    expect(all).toContain('name = \\"agent.run\\"')
    expect(all).toContain("span.agent.conversation_id")
    expect(one).toContain('name = \\"engine.run\\"')
    expect(one).toContain('name = \\"engine.turn\\"')
    expect(`${all}${one}`).not.toContain("span.agent.kind")
  })
})
