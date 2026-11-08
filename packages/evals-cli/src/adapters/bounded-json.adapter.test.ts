import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect, Option } from "effect"
import fc from "fast-check"
import { decodeJsonChunks, encodeJsonChunks } from "./bounded-json.adapter.js"

const failure = (error: unknown) => error
afterEach(() => mock.restore())
const encode = async (value: unknown, pretty = true, size = 64) => {
  const chunks: Array<string> = []
  await Effect.runPromise(encodeJsonChunks(value, (text) => Effect.sync(() => { chunks.push(text) }), failure, pretty, size))
  return chunks
}
const decode = (text: string, size = 7) => {
  const cursor = { at: 0 }
  return Effect.runPromise(decodeJsonChunks(() => Effect.sync(() => {
    if (cursor.at === text.length) return Option.none<string>()
    const chunk = text.slice(cursor.at, cursor.at + size)
    cursor.at += chunk.length
    return Option.some(chunk)
  }), failure))
}

test("bounded encoding and parsing match the native codecs across generated JSON values", async () => {
  const utf16 = fc.array(fc.integer({ min: 0, max: 65535 }), { maxLength: 200 }).map((units) => String.fromCharCode(...units))
  await fc.assert(fc.asyncProperty(fc.oneof(fc.jsonValue(), utf16), fc.integer({ min: 2, max: 31 }), async (value, size) => {
    const text = JSON.stringify(value, null, 2)
    expect((await encode(value, true, size)).join("")).toBe(text)
    expect<unknown>(await decode(text, size)).toEqual(value)
  }), { numRuns: 150 })
})

test("a single large escaped string, key and container never reach a whole-value native codec or sink", async () => {
  const scalar = '\u0000\\"é日本語😀\ud800\udc00'.repeat(400)
  const value = { [scalar]: Array.from({ length: 50 }, (_, index) => ({ index, scalar })) }
  const expected = JSON.stringify(value, null, 2)
  const stringify = JSON.stringify.bind(JSON)
  const parse = JSON.parse.bind(JSON)
  const observed = { container: false, string: 0, parsed: 0 }
  const native = spyOn(JSON, "stringify").mockImplementation((entry, replacer, space) => {
    if (typeof entry === "object" && entry !== null) observed.container = true
    if (typeof entry === "string") observed.string = Math.max(observed.string, entry.length)
    return typeof replacer === "function" ? stringify(entry, replacer, space) : stringify(entry, replacer, space)
  })
  const chunks = await encode(value, true, 64)
  native.mockRestore()
  expect(observed.container).toBe(false)
  expect(observed.string).toBeLessThanOrEqual(11)
  expect(chunks.reduce((maximum, chunk) => Math.max(maximum, chunk.length), 0)).toBeLessThanOrEqual(64)
  expect(chunks.join("")).toBe(expected)
  const parser = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    observed.parsed = Math.max(observed.parsed, text.length)
    return parse(text, reviver)
  })
  expect(await decode(expected, 63)).toEqual(value)
  parser.mockRestore()
  expect(observed.parsed).toBeLessThanOrEqual(64)
})

const scalars: ReadonlyArray<unknown> = [
  null, false, true, 0, -0, NaN, Infinity, -Infinity, 1e-10, 1e100,
  "é日本語😀\ud800\udc00\ud800x\udc00\u0000\u001f\n\r\t\b\f\u2028\u2029",
  new Number(3), new Number(NaN), new String("😀x"), new Boolean(false),
]
describe("native serialization semantics", () => {
  scalars.forEach((value, index) => test(`scalar ${index}`, async () => {
    expect((await encode(value)).join("")).toBe(JSON.stringify(value, null, 2))
  }))
  test("omissions, sparse arrays, inherited indices, key order and repeated shared values", async () => {
    const array = [undefined, , () => undefined, Symbol("omitted"), NaN]
    Object.setPrototypeOf(array, Object.assign(Object.create(Array.prototype), { 1: "inherited" }))
    const shared = { value: 1 }
    const value = { z: undefined, f: () => undefined, s: Symbol("omitted"), array, shared, again: shared, 10: "ten", 2: "two" }
    expect((await encode(value)).join("")).toBe(JSON.stringify(value, null, 2))
    expect((await encode(value, false)).join("")).toBe(JSON.stringify(value))
  })
  test("toJSON receives the original receiver and key, executes once per occurrence, and does not re-normalize its return", async () => {
    const calls: Array<string> = []
    const returned = { data: "result", toJSON: () => "wrong second conversion" }
    const source = { toJSON(key: string) { expect(this).toBe(source); calls.push(key); return returned } }
    const callable = Object.assign(() => undefined, { toJSON: (key: string) => key })
    const value = { first: source, nested: [source, callable] }
    const text = JSON.stringify(value, null, 2)
    calls.length = 0
    expect((await encode(value)).join("")).toBe(text)
    expect(calls).toEqual(["first", "0"])
  })
  test("boxed conversion occurs after toJSON and retains native numeric conversion", async () => {
    const number = new Number(2)
    number.valueOf = () => 9
    const boolean = new Boolean(false)
    boolean.valueOf = () => true
    const string = new String("old")
    string.toString = () => "new"
    const value = { number, boolean, string, converted: { toJSON: () => Object.assign(new Number(7), { toJSON: () => 99 }) } }
    expect((await encode(value)).join("")).toBe(JSON.stringify(value, null, 2))
  })
  test("array lengths and object keys are captured once, before value getters mutate them", async () => {
    const make = () => {
      const array = new Proxy(["first", "second", "third"], { get: (target, key, receiver) => key === "length" ? "2.9" : Reflect.get(target, key, receiver) })
      const value = { get first() { Reflect.deleteProperty(value, "last"); return array }, last: "removed" }
      return value
    }
    expect((await encode(make())).join("")).toBe(JSON.stringify(make(), null, 2))
  })
  test("BigInt, cycles and getters fail; shared descendants are allowed", async () => {
    await expect(encode({ bigint: 1n })).rejects.toBeDefined()
    await expect(encode(Object(1n))).rejects.toBeDefined()
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    await expect(encode(cycle)).rejects.toBeDefined()
    const result = await Effect.runPromise(encodeJsonChunks({ get value() { return JSON.parse("invalid getter value") } }, () => Effect.void, failure).pipe(Effect.flip))
    expect(result).toBeInstanceOf(SyntaxError)
  })
})

test("the parser retains native own properties and duplicate-key order without prototype mutation", async () => {
  const text = '{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"a":0,"a":3,"2":4,"1":5}'
  const value = await decode(text, 1)
  expect(value).toEqual(JSON.parse(text))
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  expect(Object.keys(Object(value))).toEqual(Object.keys(JSON.parse(text)))
  expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true)
  expect(Reflect.get({}, "polluted")).toBeUndefined()
})

test("the parser matches native numbers, escaped surrogates and every chunk boundary", async () => {
  const text = '[0,-0,1e400,-1e400,1.7976931348623157e308,5e-324,12345678901234567890,"\\ud800\\udc00\\ud800x\\udc00\\u0000\\/\\b\\f\\n\\r\\t\\\\\\\""]'
  await Promise.all([1, 2, 3, 4, 5, 7, 64].map(async (size) => expect(await decode(text, size)).toEqual(JSON.parse(text))))
})

const invalid = ["", " ", "[", "{", "[1,]", '{"a":1,}', "01", "+1", ".1", "1.", "1e", "1e+", "--1", "true false", "{}[]", "NaN", "Infinity", "undefined", "[1 2]", '{"a" 1}', '{1:2}', '"\n"', '"\\q"', '"\\u12xz"', '"\\u123', '"\\', '"unfinished', "\u00a0null", "\ufeffnull", "null\u0000"]
invalid.forEach((text, index) => test(`strict invalid JSON ${index}`, async () => {
  await Promise.all([1, 7].map(async (size) => await expect(decode(text, size)).rejects.toBeDefined()))
}))
