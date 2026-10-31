import assert from "node:assert/strict"
import { channel } from "node:diagnostics_channel"
import { ConfigProvider, Context, Effect, Option, Predicate } from "effect"
import { CurrentManagedModelsTransport, ModelsTransport } from "../ports/models-transport.port.js"
import { modelsTransportContextFor } from "./models-transport.adapter.js"

// Run as a bundled Node subprocess: diagnostics inspect actual undici Client
// instances, including the proxy's CONNECT client, without replacing factories.
const clients: Array<{ readonly client: object; readonly headers: unknown; readonly body: unknown }> = []
const symbolValue = (object: object, description: string): unknown => {
  const key = Object.getOwnPropertySymbols(object).find((symbol) => symbol.description === description)
  return key === undefined ? undefined : Reflect.get(object, key)
}
const connected = (value: unknown) => {
  if (!Predicate.hasProperty(value, "socket") || !Predicate.isObject(value.socket)) return
  const client = symbolValue(value.socket, "client")
  if (!Predicate.isObject(client)) return
  clients.push({ client, headers: symbolValue(client, "headers timeout"), body: symbolValue(client, "body timeout") })
}
const diagnostics = channel("undici:client:connected")
diagnostics.subscribe(connected)
const [mode, target, proxy] = process.argv.slice(2)
assert.ok(target)
assert.ok(proxy)
const options = mode === "proxy" ? { proxy } : mode === "no-proxy" ? { noProxy: "*" } : {}
const env = mode === "no-proxy" ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {}
const fetchBefore = globalThis.fetch
const program = Effect.scoped(Effect.gen(function* () {
  const context = yield* modelsTransportContextFor(options)
  const transport = Context.getOption(context, ModelsTransport)
  assert.ok(Option.isSome(transport), "Node must install a managed transport even without a proxy")
  const managed = Context.get(context, CurrentManagedModelsTransport)
  assert.equal(Option.getOrUndefined(managed), mode === "proxy" ? undefined : transport.value, "only the exact managed direct transport may yield to a host fetch")
  const dispatcher = Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.1"))
  const first = yield* Effect.tryPromise(() => transport.value.fetch(target).then((response) => response.text()))
  assert.equal(first, "node transport fixture")
  if (mode === "proxy") {
    const remote = target.replace("127.0.0.1", "node-models.invalid")
    const second = yield* Effect.tryPromise(() => transport.value.fetch(remote).then((response) => response.text()))
    assert.equal(second, "node transport fixture")
  }
  assert.ok(clients.length >= (mode === "proxy" ? 3 : 1), "the fixture did not observe every actual Node connection")
  clients.forEach(({ headers, body }) => assert.deepEqual({ headers, body }, { headers: 0, body: 0 }, "an actual undici client retained an independent timeout"))
  assert.equal(Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.1")), dispatcher, "the transport changed the global dispatcher")
  return dispatcher
})).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)))

await Effect.runPromise(program).then((dispatcher) => {
  assert.equal(globalThis.fetch, fetchBefore, "the transport replaced global fetch")
  assert.equal(Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.1")), dispatcher, "scope closure changed the global dispatcher")
  assert.ok(clients.every(({ client }) => Reflect.get(client, "destroyed") === true), "a scoped undici client was left open")
  diagnostics.unsubscribe(connected)
  console.log(JSON.stringify({ runtime: "Node", mode, clients: clients.length, timeouts: "zero", closed: true, globalUnchanged: true }))
}, (cause) => {
  diagnostics.unsubscribe(connected)
  console.error(cause)
  process.exitCode = 1
})
