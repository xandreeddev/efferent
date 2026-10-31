import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startRecordingProxy } from "./recording-proxy.testing.js"

const temporary = await mkdtemp(join(tmpdir(), "efferent-node-transport-"))
const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("node transport fixture") })
beforeAll(async () => {
  await mkdir(join(temporary, "node_modules"))
  await symlink(resolve(import.meta.dir, "../../node_modules/effect"), join(temporary, "node_modules/effect"), "dir")
  await symlink(resolve(import.meta.dir, "../../node_modules/undici"), join(temporary, "node_modules/undici"), "dir")
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "models-transport.node.testing.ts")], outdir: temporary,
    target: "node", format: "esm", external: ["effect", "effect/*", "undici"],
  })
  expect(built.success).toBe(true)
})
afterAll(async () => {
  target.stop(true)
  await rm(temporary, { recursive: true, force: true })
})

describe("managed Node dispatcher options", () => {
  Array.of("default", "no-proxy", "proxy").map((mode) => test(`${mode} uses actual zero-timeout clients and closes them without global mutation`, async () => {
    const proxy = await startRecordingProxy()
    const child = Bun.spawn(["node", join(temporary, "models-transport.node.testing.js"), mode, `http://127.0.0.1:${target.port}/fixture`, proxy.url], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "" },
    })
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    const code = await child.exited
    const observed = { code, errors: await errors, report: await output }
    await proxy.close()
    expect(observed.code === 0 ? observed.errors : observed).toEqual("")
    expect(observed.report).toContain('"runtime":"Node"')
    expect(observed.report).toContain('"timeouts":"zero","closed":true,"globalUnchanged":true')
    expect(proxy.seen.map((request) => request.kind)).toEqual(mode === "proxy" ? ["connect"] : [])
  }, 20_000))
})
