import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { confirmOnRegistry, onRegistry, checkRegistryProvenance } from "./npm-registry.js"

const item = { name: "@fixture/core", version: "1.0.0" }
afterEach(() => mock.restore())

test("an ambiguous upload is confirmed only from the expected source commit", async () => {
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ ...item, gitHead: "other" }), { preconnect: () => {} }))
  expect(await confirmOnRegistry(item, "expected", { attempts: 1, intervalMillis: 1000 })).toMatchObject({ _tag: "Missing" })
})

test("registry reads cancel discarded bodies and bound metadata", async () => {
  const cancelled: boolean[] = []
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)), cancel: () => { cancelled.push(true) } })), { preconnect: () => {} }))
  expect((await onRegistry(item))._tag).toBe("Success")
  expect((await checkRegistryProvenance(item, "expected"))._tag).toBe("Failure")
  expect(cancelled).toEqual([true, true])
})

test("confirmation passes the remaining wall deadline to a stalled request", async () => {
  let requested = 0
  spyOn(globalThis, "fetch").mockImplementation(Object.assign((_input: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    requested++
    options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true })
  }), { preconnect: () => {} }))
  expect((await confirmOnRegistry(item, "expected", { attempts: 2, intervalMillis: 5 }))._tag).toBe("Missing")
  expect(requested).toBe(1)
})
