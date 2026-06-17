type JsonScalar = string | number | boolean | null
export type JsonValue = JsonScalar | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }

export const TRACE_PAYLOAD_CAP = 20_000
export const TRACE_STRING_CAP = 8_000
export const TRACE_DEPTH_CAP = 8
export const TRACE_ARRAY_CAP = 80
export const TRACE_OBJECT_KEYS_CAP = 120

const REDACTED = "[REDACTED]"

const secretKeyPattern =
  /(?:^|[_-])(authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|cookie|set[_-]?cookie)(?:$|[_-])/i

const envSecretPattern =
  /^([A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|PASSWD|SECRET|COOKIE|AUTHORIZATION)[A-Z0-9_]*\s*=).*/gm

const redactText = (s: string): string => s.replace(envSecretPattern, `$1${REDACTED}`)

const clip = (s: string, max: number): string => {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head - 32
  return `${s.slice(0, head)}\n…[${s.length - head - tail} chars elided]…\n${s.slice(s.length - tail)}`
}

const scalar = (value: unknown): JsonValue | undefined => {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return clip(redactText(value), TRACE_STRING_CAP)
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "boolean") return value
  if (typeof value === "bigint") return String(value)
  if (typeof value === "symbol") return String(value)
  if (typeof value === "function") return "[Function]"
  return undefined
}

const safeValue = (
  value: unknown,
  seen: Set<object>,
  depth: number,
): JsonValue => {
  const s = scalar(value)
  if (s !== undefined) return s
  if (depth >= TRACE_DEPTH_CAP) return "[MaxDepth]"
  if (typeof value !== "object" || value === null) return String(value)
  if (seen.has(value)) return "[Circular]"
  seen.add(value)

  if (Array.isArray(value)) {
    const items = value.slice(0, TRACE_ARRAY_CAP).map((v) => safeValue(v, seen, depth + 1))
    if (value.length > TRACE_ARRAY_CAP) {
      return [...items, `…[${value.length - TRACE_ARRAY_CAP} items elided]`]
    }
    return items
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const out: Record<string, JsonValue> = {}
  for (const [key, val] of entries.slice(0, TRACE_OBJECT_KEYS_CAP)) {
    out[key] = secretKeyPattern.test(key) ? REDACTED : safeValue(val, seen, depth + 1)
  }
  if (entries.length > TRACE_OBJECT_KEYS_CAP) {
    out["…"] = `[${entries.length - TRACE_OBJECT_KEYS_CAP} keys elided]`
  }
  return out
}

export const traceJsonValue = (value: unknown): JsonValue => safeValue(value, new Set(), 0)

export const traceJson = (value: unknown, maxChars = TRACE_PAYLOAD_CAP): string =>
  clip(JSON.stringify(traceJsonValue(value)), maxChars)
