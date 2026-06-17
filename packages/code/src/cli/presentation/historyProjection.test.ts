import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@xandreed/sdk-core"
import { projectHistory } from "./historyProjection.js"
import type { TreeNode } from "./executionTree.js"

const user = (text: string): AgentMessage => ({ role: "user", content: text })
const assistant = (
  parts: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  >,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number },
): AgentMessage => ({
  role: "assistant",
  content: parts,
  ...(usage !== undefined ? { providerOptions: { efferent: usage } } : {}),
})
const toolResult = (
  toolCallId: string,
  toolName: string,
  output: unknown,
  isError = false,
): AgentMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId, toolName, output, isError }],
})

const flat = (roots: ReadonlyArray<TreeNode>): TreeNode[] => {
  const out: TreeNode[] = []
  const walk = (n: TreeNode): void => {
    out.push(n)
    n.children.forEach(walk)
  }
  roots.forEach(walk)
  return out
}

describe("projectHistory — the activity tree derived from messages", () => {
  test("run → turn → tool nesting, usage detail, all-terminal statuses, zero timestamps", () => {
    const { tree, foldIds } = projectHistory(
      [
        user("fix the parser"),
        assistant(
          [
            { type: "text", text: "reading" },
            { type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "a.ts" } },
          ],
          { inputTokens: 100, outputTokens: 2000, totalTokens: 2100, cacheReadTokens: 0 },
        ),
        toolResult("t1", "read_file", { content: "x", totalLines: 12 }),
        assistant([{ type: "text", text: "done" }]),
      ],
      [],
    )
    expect(tree.roots).toHaveLength(1)
    const run = tree.roots[0]!
    expect(run.kind).toBe("run")
    expect(run.label).toBe("fix the parser")
    expect(run.children.map((c) => c.kind)).toEqual(["turn", "turn"])
    const turn1 = run.children[0]!
    expect(turn1.detail).toBe("2k tok")
    expect(turn1.children).toHaveLength(1)
    expect(turn1.children[0]).toMatchObject({ kind: "tool", status: "ok", detail: "12 lines" })
    // Nothing running, nothing timed: a rebuilt tree is terminal and timeless.
    for (const n of flat(tree.roots)) {
      expect(n.status).not.toBe("running")
      expect(n.startedAt).toBe(0)
      expect(n.endedAt ?? 0).toBe(0)
    }
    expect(foldIds).toEqual(new Set([`node:${run.id}`]))
  })

  test("two same-named calls pair FIFO; an errored result closes its own leaf", () => {
    const { tree } = projectHistory(
      [
        user("go"),
        assistant([
          { type: "tool-call", toolCallId: "a", toolName: "read_file", input: { path: "1.ts" } },
          { type: "tool-call", toolCallId: "b", toolName: "read_file", input: { path: "2.ts" } },
        ]),
        toolResult("a", "read_file", { content: "x", totalLines: 1 }),
        toolResult("b", "read_file", { message: "FileNotFound" }, true),
      ],
      [],
    )
    const tools = flat(tree.roots).filter((n) => n.kind === "tool")
    expect(tools.map((t) => t.status)).toEqual(["ok", "error"])
    expect(tools[1]!.detail).toBe("FileNotFound")
  })

  test("run_agent becomes a subagent container: nodeId stamped from the result, files detail", () => {
    const { tree } = projectHistory(
      [
        user("audit"),
        assistant([
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "run_agent",
            input: { folder: "/w/pkg/tui", task: "t", seedMode: "handoff" },
          },
        ]),
        toolResult("c1", "run_agent", {
          summary: "done well",
          filesChanged: ["a.ts", "b.ts"],
          nodeId: "node-9",
        }),
      ],
      [],
    )
    const sub = flat(tree.roots).find((n) => n.kind === "subagent")!
    expect(sub.label).toBe("run_agent → tui · handoff")
    expect(sub.status).toBe("ok")
    expect(sub.detail).toBe("2 files")
    expect(sub.nodeId).toBe("node-9")
  })

  test("a run_agent call's `name` labels its container and row (folder is the fallback)", () => {
    const { tree, blocks } = projectHistory(
      [
        user("audit"),
        assistant([
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "run_agent",
            input: { name: "audit state layer", folder: "/w/pkg/tui", task: "t" },
          },
        ]),
        toolResult("c1", "run_agent", { summary: "ok", filesChanged: [], nodeId: "n1" }),
      ],
      [],
    )
    const sub = flat(tree.roots).find((n) => n.kind === "subagent")!
    expect(sub.label).toBe("run_agent → audit state layer")
    const ag = blocks.find((b) => b.kind === "agents")
    if (ag?.kind !== "agents") throw new Error("expected agents block")
    expect(ag.agents[0]!.name).toBe("audit state layer")
  })

  test("a failed run_agent closes its container as error", () => {
    const { tree } = projectHistory(
      [
        user("audit"),
        assistant([
          { type: "tool-call", toolCallId: "c1", toolName: "run_agent", input: { folder: "/w/x", task: "t" } },
        ]),
        toolResult("c1", "run_agent", { error: "MaxDepthReached", message: "too deep" }, true),
      ],
      [],
    )
    const sub = flat(tree.roots).find((n) => n.kind === "subagent")!
    expect(sub.status).toBe("error")
    expect(sub.detail).toBe("too deep")
  })

  test("a dangling tool-call (interrupted turn) is closed ok, never left running", () => {
    const { tree } = projectHistory(
      [
        user("go"),
        assistant([
          { type: "tool-call", toolCallId: "a", toolName: "Bash", input: { command: "ls" } },
        ]),
        // no tool result — the run was interrupted
      ],
      [],
    )
    for (const n of flat(tree.roots)) expect(n.status).toBe("ok")
  })

  test("filesChanged accumulates edit results across the history", () => {
    const { filesChanged } = projectHistory(
      [
        user("edit twice"),
        assistant([
          { type: "tool-call", toolCallId: "e1", toolName: "edit_file", input: { path: "a.ts" } },
        ]),
        toolResult("e1", "edit_file", {
          path: "a.ts",
          diff: "--- a.ts\n+++ a.ts\n@@ -1,1 +1,2 @@\n-x\n+y\n+z\n",
        }),
        assistant([
          { type: "tool-call", toolCallId: "e2", toolName: "edit_file", input: { path: "a.ts" } },
        ]),
        toolResult("e2", "edit_file", {
          path: "a.ts",
          diff: "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-y\n+q\n",
        }),
      ],
      [],
    )
    expect(filesChanged).toHaveLength(1)
    expect(filesChanged[0]).toMatchObject({ path: "a.ts", added: 3, removed: 2 })
  })

  test("the loaded plan is the LAST update_plan call's checklist", () => {
    const { plan } = projectHistory(
      [
        user("go"),
        assistant([
          {
            type: "tool-call",
            toolCallId: "p1",
            toolName: "update_plan",
            input: { steps: [{ step: "a", status: "active" }] },
          },
        ]),
        toolResult("p1", "update_plan", { total: 1, done: 0 }),
        assistant([
          {
            type: "tool-call",
            toolCallId: "p2",
            toolName: "update_plan",
            input: { steps: [{ step: "a", status: "done" }, { step: "b", status: "active" }] },
          },
        ]),
        toolResult("p2", "update_plan", { total: 2, done: 1 }),
      ],
      [],
    )
    expect(plan.map((s) => `${s.step}:${s.status}`)).toEqual(["a:done", "b:active"])
  })

  test("an assistant-first history (built/forked sets) yields foldable turn roots", () => {
    const { tree, foldIds } = projectHistory(
      [
        assistant([{ type: "text", text: "carried context" }]),
        user("continue"),
        assistant([{ type: "text", text: "ok" }]),
      ],
      [],
    )
    expect(tree.roots.map((r) => r.kind)).toEqual(["turn", "run"])
    expect(foldIds).toEqual(new Set(tree.roots.map((r) => `node:${r.id}`)))
  })
})
