import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { writeJsonObject } from "./json-file.js"

test("credential temporaries are private before serialization writes their first byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "auth-private-create-"))
  const seen: number[] = []
  await (async () => {
    const path = join(directory, "auth.json")
    const value = { toJSON: () => {
      seen.push(...readdirSync(directory).filter((name) => name.includes(".tmp-")).map((name) => statSync(join(directory, name)).mode & 0o777))
      return { credential: "fixture-only" }
    } }
    await Effect.runPromise(writeJsonObject(path, value, Option.some(0o600), (reason) => new Error(reason)))
    expect(seen).toEqual([0o600])
    expect(await readFile(path, "utf8")).toBe('{\n  "credential": "fixture-only"\n}')
    expect(await readdir(directory)).toEqual(["auth.json"])
  })().finally(() => rm(directory, { recursive: true, force: true }))
})

test("a failed serialization closes and removes its private temporary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "auth-failed-write-"))
  await (async () => {
    const proxy = Proxy.revocable({}, {})
    proxy.revoke()
    const result = await Effect.runPromise(Effect.result(writeJsonObject(join(directory, "auth.json"), { bad: proxy.proxy }, Option.some(0o600), (reason) => new Error(reason))))
    expect(result._tag).toBe("Failure")
    expect(await readdir(directory)).toEqual([])
  })().finally(() => rm(directory, { recursive: true, force: true }))
})

test("a file written without a mode takes the default permissions, and a missing directory is created private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-default-mode-"))
  await (async () => {
    const path = join(directory, ".efferent", "config.json")
    await Effect.runPromise(writeJsonObject(path, { maxAttempts: 3 }, Option.none(), (reason) => new Error(reason)))
    const umask = process.umask()
    expect([statSync(path).mode & 0o777, statSync(join(directory, ".efferent")).mode & 0o777]).toEqual([0o666 & ~umask, 0o700 & ~umask])
  })().finally(() => rm(directory, { recursive: true, force: true }))
})

test("a failed write names the step that failed and the system's error code, and keeps the error as its cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-failed-rename-"))
  await (async () => {
    // A directory where the file goes: every step succeeds but the rename over it.
    const path = join(directory, "config.json")
    await mkdir(path)
    const failure = await Effect.runPromise(Effect.flip(writeJsonObject(path, { maxAttempts: 3 }, Option.none(), (reason, cause) => ({ reason, cause }))))
    expect(failure.reason).toMatch(/^rename failed \((EISDIR|ENOTEMPTY|EEXIST|EPERM)\)$/)
    expect(failure.cause).toBeInstanceOf(Error)
    expect(await readdir(directory)).toEqual(["config.json"])
  })().finally(() => rm(directory, { recursive: true, force: true }))
})
