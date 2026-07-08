import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Redacted } from "effect"
import { AuthStore, ProviderId } from "@xandreed/engine"
import { LocalAuthStoreLive } from "./localAuth.js"

const setup = (global: Record<string, unknown>, local?: Record<string, unknown>) => {
  const home = mkdtempSync(join(tmpdir(), "engine-auth-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "engine-auth-cwd-"))
  mkdirSync(join(home, ".efferent"), { recursive: true })
  writeFileSync(join(home, ".efferent", "auth.json"), JSON.stringify(global))
  if (local !== undefined) {
    mkdirSync(join(cwd, ".efferent"), { recursive: true })
    writeFileSync(join(cwd, ".efferent", "auth.json"), JSON.stringify(local))
  }
  return LocalAuthStoreLive(cwd, home)
}

/** Like `setup` but returns the dirs too (the write-surface tests inspect files). */
const setupWithPaths = (global: Record<string, unknown>, local?: Record<string, unknown>) => {
  const home = mkdtempSync(join(tmpdir(), "engine-auth-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "engine-auth-cwd-"))
  mkdirSync(join(home, ".efferent"), { recursive: true })
  writeFileSync(join(home, ".efferent", "auth.json"), JSON.stringify(global))
  if (local !== undefined) {
    mkdirSync(join(cwd, ".efferent"), { recursive: true })
    writeFileSync(join(cwd, ".efferent", "auth.json"), JSON.stringify(local))
  }
  return { layer: LocalAuthStoreLive(cwd, home), home, cwd }
}

const opencode = ProviderId.make("opencode")

describe("LocalAuthStoreLive", () => {
  test("api_key resolves; legacy flat-string entries read as api keys", async () => {
    const layer = setup({
      opencode: { type: "api_key", key: "sk-modern" },
      google: "legacy-flat-key",
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        const key = yield* auth.resolveKey(opencode)
        expect(Redacted.value(Option.getOrThrow(key))).toBe("sk-modern")
        const legacy = yield* auth.get(ProviderId.make("google"))
        expect(Option.getOrThrow(legacy)).toEqual({ type: "api_key", key: "legacy-flat-key" })
      }).pipe(Effect.provide(layer)),
    )
  })

  test("local auth.json overrides global per provider", async () => {
    const layer = setup(
      { opencode: { type: "api_key", key: "global-key" } },
      { opencode: { type: "api_key", key: "local-key" } },
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        const key = yield* auth.resolveKey(opencode)
        expect(Redacted.value(Option.getOrThrow(key))).toBe("local-key")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("unconfigured provider resolves None; a fresh oauth token is used as-is", async () => {
    const layer = setup({
      anthropic: {
        type: "oauth",
        access: "fresh-access",
        refresh: "r",
        expires: Date.now() + 3_600_000,
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        expect(Option.isNone(yield* auth.resolveKey(opencode))).toBe(true)
        const anthropic = yield* auth.resolveKey(ProviderId.make("anthropic"))
        expect(Redacted.value(Option.getOrThrow(anthropic))).toBe("fresh-access")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("an expired non-anthropic oauth fails with a clear message (no refresh wired)", async () => {
    const layer = setup({
      openai: { type: "oauth", access: "stale", refresh: "r", expires: Date.now() - 1 },
    })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        return yield* auth.resolveKey(ProviderId.make("openai"))
      }).pipe(Effect.provide(layer)),
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("refresh flow isn't wired")
  })
})

describe("LocalAuthStore — the write surface (:login / :logout)", () => {
  test("set persists to the GLOBAL file, 0600, preserving other providers", async () => {
    const { layer, home } = setupWithPaths({ opencode: "sk-opencode" })
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AuthStore
        yield* store.set(ProviderId.make("openai"), { type: "api_key", key: "sk-test" })
        const all = yield* store.all
        expect(all.get("openai")).toEqual({ type: "api_key", key: "sk-test" })
        expect(all.get("opencode")).toEqual({ type: "api_key", key: "sk-opencode" })
      }).pipe(Effect.provide(layer)),
    )
    const path = join(home, ".efferent", "auth.json")
    const written = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
    expect(written["openai"]).toEqual({ type: "api_key", key: "sk-test" })
    // legacy flat entry survives the round-trip as a typed credential
    expect(written["opencode"]).toEqual({ type: "api_key", key: "sk-opencode" })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("remove clears the provider from EVERY tier that holds it", async () => {
    const { layer, home, cwd } = setupWithPaths(
      { openai: { type: "api_key", key: "global" } },
      { openai: { type: "api_key", key: "local-override" } },
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AuthStore
        yield* store.remove(ProviderId.make("openai"))
        const all = yield* store.all
        expect(all.has("openai")).toBe(false)
      }).pipe(Effect.provide(layer)),
    )
    const globalFile = JSON.parse(
      readFileSync(join(home, ".efferent", "auth.json"), "utf-8"),
    ) as Record<string, unknown>
    const localFile = JSON.parse(
      readFileSync(join(cwd, ".efferent", "auth.json"), "utf-8"),
    ) as Record<string, unknown>
    expect("openai" in globalFile).toBe(false)
    expect("openai" in localFile).toBe(false)
  })
})

