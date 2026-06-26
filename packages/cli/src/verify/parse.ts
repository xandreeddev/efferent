/**
 * Pure parsers for the headless surfaces the keyed tiers assert on — `--mode
 * json` (JSONL of AgentEvents) and `--mode rpc` (JSON-RPC over stdio). Kept
 * dependency-light and tolerant of malformed/partial lines so a stray log line
 * never crashes the harness; unit-tested in parse.test.ts without spawning.
 */

export interface ToolCall {
  readonly name: string
  readonly ok: boolean
}

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

/** Parse JSONL lines into loosely-typed event objects, dropping non-JSON noise. */
export const parseJsonlEvents = (stdout: string): ReadonlyArray<Record<string, unknown>> => {
  const out: Record<string, unknown>[] = []
  for (const line of lines(stdout)) {
    if (line[0] !== "{") continue
    const parsed = safeParse(line)
    if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>)
  }
  return out
}

const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** The final assistant text from an `agent_end` event, if any. */
export const finalTextOf = (events: ReadonlyArray<Record<string, unknown>>): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e["type"] === "agent_end" && typeof e["finalText"] === "string") {
      return e["finalText"] as string
    }
  }
  return undefined
}

/** The completed tool calls (name + ok) in order, from `tool_call_end` events. */
export const toolCallsOf = (events: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<ToolCall> => {
  const calls: ToolCall[] = []
  for (const e of events) {
    if (e["type"] === "tool_call_end" && typeof e["toolName"] === "string") {
      calls.push({ name: e["toolName"] as string, ok: e["ok"] === true })
    }
  }
  return calls
}

/** True if any tool of one of `names` completed ok. */
export const usedToolOk = (
  events: ReadonlyArray<Record<string, unknown>>,
  names: ReadonlyArray<string>,
): boolean => toolCallsOf(events).some((t) => t.ok && names.includes(t.name))

export interface RpcParsed {
  /** Lines carrying a JSON-RPC `id` (request responses). */
  readonly responses: ReadonlyArray<Record<string, unknown>>
  /** Lines carrying a `method` but no `id` (event notifications). */
  readonly notifications: ReadonlyArray<Record<string, unknown>>
}

/** Split a captured `--mode rpc` stdout into responses vs notifications. */
export const parseRpcLines = (stdout: string): RpcParsed => {
  const responses: Record<string, unknown>[] = []
  const notifications: Record<string, unknown>[] = []
  for (const line of lines(stdout)) {
    if (line[0] !== "{") continue
    const v = safeParse(line)
    if (!v || typeof v !== "object") continue
    const obj = v as Record<string, unknown>
    if ("id" in obj && obj["id"] !== undefined && obj["id"] !== null) responses.push(obj)
    else if (typeof obj["method"] === "string") notifications.push(obj)
  }
  return { responses, notifications }
}

/** The `result` of the JSON-RPC response with this id, if it arrived. */
export const rpcResultFor = (parsed: RpcParsed, id: number | string): unknown => {
  const r = parsed.responses.find((x) => x["id"] === id)
  return r ? r["result"] : undefined
}
