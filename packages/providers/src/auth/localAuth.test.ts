import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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
