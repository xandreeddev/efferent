import { isBigIntObject, isBooleanObject, isNumberObject, isStringObject } from "node:util/types"
import { Effect, Option, Schema } from "effect"

/** Bound temporary JSON text, independently of the size of a container or string. */
export const JSON_CHUNK_CHARACTERS = 64 << 10

const objectLike = (value: unknown): value is object => value !== null && (typeof value === "object" || typeof value === "function")
const omitted = (value: unknown) => value === undefined || typeof value === "function" || typeof value === "symbol"
const normalize = (value: unknown, key: string): unknown => {
  const method: unknown = objectLike(value) || typeof value === "bigint" ? Reflect.get(Object(value), "toJSON") : undefined
  const converted: unknown = typeof method === "function" ? Reflect.apply(method, value, [key]) : value
  return isStringObject(converted) ? String(converted) : converted
}
const rawJson = (value: object): Option.Option<string> => {
  const isRaw: unknown = Reflect.get(JSON, "isRawJSON")
  const text: unknown = typeof isRaw === "function" && Reflect.apply(isRaw, JSON, [value]) ? Reflect.get(value, "rawJSON") : undefined
  return typeof text === "string" ? Option.some(text) : Option.none()
}
/** Keep a UTF-16 pair in one write: Buffer.from must not replace either half. */
const cutAt = (text: string, maximum: number) => {
  const cut = Math.min(text.length, Math.max(2, maximum))
  return cut < text.length && /[\ud800-\udbff]/.test(text.charAt(cut - 1)) && /[\udc00-\udfff]/.test(text.charAt(cut)) ? cut - 1 : cut
}
interface ObjectFrame { readonly value: object; readonly keys: ReadonlyArray<string>; index: number; count: number; readonly depth: number }
interface ArrayFrame { readonly value: ReadonlyArray<unknown>; readonly length: number; index: number; readonly depth: number }
type Frame = ObjectFrame | ArrayFrame

/**
 * Native JSON.stringify semantics, without a whole container's text. Native
 * scalar encoding is used only for bounded string slices and numeric wrappers.
 * The caller owns IO errors; exceptions from getters/toJSON retain their cause.
 */
export const encodeJsonChunks = Effect.fnUntraced(function* <E>(
  value: unknown,
  append: (text: string) => Effect.Effect<void, E>,
  failure: (error: unknown) => E,
  pretty = true,
  characters = JSON_CHUNK_CHARACTERS,
) {
  const size = Math.max(2, characters)
  const buffer = { text: "" }
  const flush = Effect.suspend(() => buffer.text.length === 0 ? Effect.void : append(buffer.text).pipe(Effect.tap(() => Effect.sync(() => { buffer.text = "" }))))
  const emit = (text: string): Effect.Effect<void, E> => Effect.suspend(() => {
    const cut = cutAt(text, size)
    const part = text.slice(0, cut)
    return (buffer.text.length + part.length > size ? flush : Effect.void).pipe(
      Effect.tap(() => Effect.sync(() => { buffer.text += part })),
      Effect.andThen(cut < text.length ? Effect.suspend(() => emit(text.slice(cut))) : Effect.void),
    )
  })
  // Each slice is escaped before it joins the bounded output buffer. In
  // particular a very long string containing only escapes stays bounded too.
  const string = (text: string) => Effect.gen(function* () {
    yield* emit('"')
    const position = { at: 0 }
    yield* Effect.whileLoop({
      while: () => position.at < text.length,
      body: () => Effect.try({
        try: () => {
          const fragment = text.slice(position.at, position.at + Math.max(2, Math.floor(size / 6)))
          const cut = cutAt(text.slice(position.at, position.at + fragment.length + 1), fragment.length)
          const part = text.slice(position.at, position.at + cut)
          position.at += cut
          return JSON.stringify(part).slice(1, -1)
        },
        catch: failure,
      }).pipe(Effect.flatMap(emit)),
      step: () => undefined,
    })
    yield* emit('"')
  })
  const indentation = (depth: number) => Effect.gen(function* () {
    if (!pretty) return
    yield* emit("\n")
    const remaining = { spaces: depth * 2 }
    yield* Effect.whileLoop({
      while: () => remaining.spaces > 0,
      body: () => {
        const count = Math.min(size, remaining.spaces)
        remaining.spaces -= count
        return emit(" ".repeat(count))
      },
      step: () => undefined,
    })
  })
  const stack: Array<Frame> = []
  const ancestors = new Set<object>()
  const write = (entry: unknown, depth: number): Effect.Effect<void, E> => Effect.suspend(() => {
    if (typeof entry === "string") return string(entry)
    if (isNumberObject(entry) || isBooleanObject(entry) || isBigIntObject(entry) || typeof entry === "bigint") return Effect.try({ try: () => JSON.stringify(null, () => entry), catch: failure }).pipe(Effect.flatMap(emit))
    if (!objectLike(entry)) return Effect.try({ try: () => JSON.stringify(entry), catch: failure }).pipe(Effect.flatMap((text) => text === undefined ? Effect.fail(failure(new TypeError("Value does not encode as JSON"))) : emit(text)))
    return Effect.try({ try: () => rawJson(entry), catch: failure }).pipe(Effect.flatMap((raw) => {
      if (Option.isSome(raw)) return emit(raw.value)
      if (ancestors.has(entry)) return Effect.fail(failure(new TypeError("Converting circular structure to JSON")))
      return Effect.try({
        try: () => {
          const array = Array.isArray(entry)
          ancestors.add(entry)
          stack.push(array
            ? { value: entry, length: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(entry.length))) || 0, index: 0, depth }
            : { value: entry, keys: Object.keys(entry), index: 0, count: 0, depth })
          return array ? "[" : "{"
        }, catch: failure,
      }).pipe(Effect.flatMap(emit))
    }))
  })
  const initial = yield* Effect.try({ try: () => normalize(value, ""), catch: failure })
  if (omitted(initial)) return yield* Effect.fail(failure(new TypeError("Value does not encode as JSON")))
  yield* write(initial, 0)
  yield* Effect.whileLoop({
    while: () => stack.length > 0,
    body: () => Effect.gen(function* () {
      const frame = stack[stack.length - 1]!
      const array = "length" in frame
      const length = array ? frame.length : frame.keys.length
      if (frame.index === length) {
        if ((array ? frame.index : frame.count) > 0) yield* indentation(frame.depth)
        yield* emit(array ? "]" : "}")
        ancestors.delete(frame.value)
        stack.pop()
        return
      }
      const key = array ? `${frame.index}` : frame.keys[frame.index]!
      frame.index += 1
      const entry = yield* Effect.try({ try: () => normalize(Reflect.get(frame.value, key), key), catch: failure })
      if (!array && omitted(entry)) return
      const count = array ? frame.index - 1 : frame.count++
      if (count > 0) yield* emit(",")
      yield* indentation(frame.depth + 1)
      if (!array) {
        yield* string(key)
        yield* emit(pretty ? ": " : ":")
      }
      yield* write(omitted(entry) ? null : entry, frame.depth + 1)
    }),
    step: () => undefined,
  })
  yield* flush
})

interface ObjectReadFrame { readonly kind: "object"; readonly value: Schema.JsonObject; state: "first" | "key" | "colon" | "value" | "comma"; key: string }
interface ArrayReadFrame { readonly kind: "array"; readonly value: Array<Schema.Json>; state: "first" | "value" | "comma" }
type ReadFrame = ObjectReadFrame | ArrayReadFrame
interface StringToken { readonly kind: "string"; readonly parts: Array<string>; escape: string; pending: string }
interface AtomToken { readonly kind: "atom"; readonly parts: Array<string> }
type Token = StringToken | AtomToken
const whitespace = /^[\x20\t\r\n]+/
const stringText = /^[^"\\\u0000-\u001f]+/
const atomText = /^[^\x20\t\r\n,\]}:"]+/
const numberText = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/
const escapes: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }
const decodedText = (token: StringToken, text: string) => {
  if (token.pending.length + text.length > JSON_CHUNK_CHARACTERS) {
    if (token.pending.length > 0) token.parts.push(token.pending)
    token.pending = text
  } else token.pending += text
}

/** Strict JSON grammar over bounded decoded UTF-8 chunks; scalar values and the
 * resulting object graph still occupy memory. No complete trial text is made. */
export const decodeJsonChunks = Effect.fnUntraced(function* <E>(
  next: () => Effect.Effect<Option.Option<string>, E>,
  failure: (error: unknown) => E,
) {
  const input = { text: "", at: 0, ended: false, offset: 0 }
  const frames: Array<ReadFrame> = []
  const root: { value: Schema.Json; complete: boolean } = { value: null, complete: false }
  const lex: { token: Option.Option<Token> } = { token: Option.none() }
  const invalid = () => Effect.fail(failure(new SyntaxError(`Invalid JSON at character ${input.offset + input.at}`)))
  const consume = (count: number) => { input.at += count }
  const expectsValue = () => {
    const frame = frames[frames.length - 1]
    return frame === undefined ? !root.complete : frame.state === "value" || (frame.kind === "array" && frame.state === "first")
  }
  const accept = (value: Schema.Json) => {
    const frame = frames[frames.length - 1]
    if (frame === undefined) { root.value = value; root.complete = true; return }
    if (frame.kind === "array") frame.value.push(value)
    else Object.defineProperty(frame.value, frame.key, { value, enumerable: true, writable: true, configurable: true })
    frame.state = "comma"
  }
  const finishAtom = (token: AtomToken) => Effect.try({ try: () => token.parts.join(""), catch: failure }).pipe(Effect.flatMap((text) => {
    if (text !== "true" && text !== "false" && text !== "null" && !numberText.test(text)) return invalid()
    accept(text === "true" ? true : text === "false" ? false : text === "null" ? null : Number(text))
    lex.token = Option.none()
    return Effect.void
  }))
  yield* Effect.whileLoop({
    while: () => !input.ended || input.at < input.text.length || Option.isSome(lex.token),
    body: () => Effect.gen(function* () {
      if (input.at === input.text.length && !input.ended) {
        input.offset += input.text.length
        const more = yield* next()
        input.text = Option.getOrElse(more, () => "")
        input.at = 0
        input.ended = Option.isNone(more)
        return
      }
      const text = input.text.slice(input.at)
      if (Option.isSome(lex.token)) {
        const token = lex.token.value
        if (token.kind === "atom") {
          const part = atomText.exec(text)?.[0] ?? ""
          if (part.length > 0) { token.parts.push(part); consume(part.length); return }
          yield* finishAtom(token)
          return
        }
        if (input.ended && text.length === 0) return yield* invalid()
        if (token.escape.length > 0) {
          const needed = token.escape === "\\" ? 1 : 6 - token.escape.length
          const part = text.slice(0, needed)
          token.escape += part
          consume(part.length)
          if (token.escape.length === 2 && token.escape !== "\\u") {
            const escaped = escapes[token.escape.charAt(1)]
            if (escaped === undefined) return yield* invalid()
            decodedText(token, escaped)
            token.escape = ""
          } else if (token.escape.length === 6) {
            if (!/^\\u[0-9a-fA-F]{4}$/.test(token.escape)) return yield* invalid()
            decodedText(token, String.fromCharCode(Number.parseInt(token.escape.slice(2), 16)))
            token.escape = ""
          }
          return
        }
        const part = stringText.exec(text)?.[0] ?? ""
        if (part.length > 0) { decodedText(token, part); consume(part.length); return }
        if (text.startsWith("\\")) { token.escape = "\\"; consume(1); return }
        if (!text.startsWith('"')) return yield* invalid()
        consume(1)
        token.parts.push(token.pending)
        const value = yield* Effect.try({ try: () => token.parts.join(""), catch: failure })
        const frame = frames[frames.length - 1]
        if (frame?.kind === "object" && (frame.state === "first" || frame.state === "key")) { frame.key = value; frame.state = "colon" }
        else accept(value)
        lex.token = Option.none()
        return
      }
      const spaces = whitespace.exec(text)?.[0] ?? ""
      if (spaces.length > 0) { consume(spaces.length); return }
      if (input.ended && text.length === 0) return
      const char = text.charAt(0)
      const frame = frames[frames.length - 1]
      if (char === "}" && frame?.kind === "object" && (frame.state === "first" || frame.state === "comma")) { consume(1); frames.pop(); accept(frame.value); return }
      if (char === "]" && frame?.kind === "array" && (frame.state === "first" || frame.state === "comma")) { consume(1); frames.pop(); accept(frame.value); return }
      if (char === "," && frame?.state === "comma") { consume(1); frame.state = frame.kind === "object" ? "key" : "value"; return }
      if (char === ":" && frame?.kind === "object" && frame.state === "colon") { consume(1); frame.state = "value"; return }
      const key = frame?.kind === "object" && (frame.state === "first" || frame.state === "key")
      if (char === '"' && (key || expectsValue())) { consume(1); lex.token = Option.some({ kind: "string", parts: [], escape: "", pending: "" }); return }
      if (!expectsValue()) return yield* invalid()
      if (char === "{") { consume(1); frames.push({ kind: "object", value: {}, state: "first", key: "" }); return }
      if (char === "[") { consume(1); frames.push({ kind: "array", value: [], state: "first" }); return }
      if (!/[-0-9tfn]/.test(char)) return yield* invalid()
      lex.token = Option.some({ kind: "atom", parts: [] })
    }),
    step: () => undefined,
  })
  if (!root.complete || frames.length > 0) return yield* invalid()
  return root.value
})
