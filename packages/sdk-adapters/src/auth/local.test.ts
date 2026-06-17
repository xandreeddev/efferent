import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthStore } from "@xandreed/sdk-core"
import { Effect, Redacted } from "effect"
import { LocalAuthStoreLive } from "./local.js"

// The adapter resolves its dir from EFFERENT_HOME (falling back to ~/.efferent),
// so each test points it at a fresh temp dir — never touching the real config.
let home: string
let savedHome: string | undefined

beforeEach(() => {
  savedHome = process.env.EFFERENT_HOME
  home = mkdtempSync(join(tmpdir(), "efferent-auth-"))
  process.env.EFFERENT_HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.EFFERENT_HOME
  else process.env.EFFERENT_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const authPath = (): string => join(home, ".efferent", "auth.json")
const run = <A, E>(e: Effect.Effect<A, E, AuthStore>): Promise<A> =>
  Effect.runPromise(e.pipe(Effect.provide(LocalAuthStoreLive)))

describe("LocalAuthStore", () => {
  it("set/get/remove an API key, persisted to auth.json", async () => {
    const out = await run(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.setApiKey("anthropic", "sk-ant-1")
        const cred = yield* auth.get("anthropic")
        const all = yield* auth.all
        const key = yield* auth.resolveKey("anthropic")
        yield* auth.remove("anthropic")
        const afterRemove = yield* auth.get("anthropic")
        return { cred, providers: Object.keys(all), key, afterRemove }
      }),
    )
    expect(out.cred).toEqual({ type: "api_key", key: "sk-ant-1" })
    expect(out.providers).toEqual(["anthropic"])
    expect(out.key && Redacted.value(out.key)).toBe("sk-ant-1")
    expect(out.afterRemove).toBeUndefined()

    // The on-disk shape is the per-provider object form, and the key survives
    // a remove of a *different* provider's entry only — here it's gone.
    expect(existsSync(authPath())).toBe(true)
    const onDisk = JSON.parse(readFileSync(authPath(), "utf8"))
    expect(onDisk.anthropic).toBeUndefined()
  })

  it("writes an OAuth credential with access/refresh/expires", async () => {
    await run(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.setOAuth("anthropic", {
          access: "acc",
          refresh: "ref",
          expires: 9_999_999_999_999,
        })
      }),
    )
    const onDisk = JSON.parse(readFileSync(authPath(), "utf8"))
    expect(onDisk.anthropic).toEqual({
      type: "oauth",
      access: "acc",
      refresh: "ref",
      expires: 9_999_999_999_999,
    })
  })

  it("writes an OpenAI OAuth credential with a stable installation id", async () => {
    await run(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.setOAuth("openai", {
          access: "acc",
          refresh: "ref",
          expires: 9_999_999_999_999,
          accountId: "acct_1",
        })
      }),
    )
    const onDisk = JSON.parse(readFileSync(authPath(), "utf8"))
    expect(onDisk.openai).toEqual({
      type: "oauth",
      access: "acc",
      refresh: "ref",
      expires: 9_999_999_999_999,
      accountId: "acct_1",
      installationId: expect.any(String),
    })
  })

  it("backfills missing OpenAI OAuth installation ids from old auth.json files", async () => {
    mkdirSync(join(home, ".efferent"), { recursive: true })
    writeFileSync(
      authPath(),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "acc",
          refresh: "ref",
          expires: 9_999_999_999_999,
          accountId: "acct_1",
        },
      }),
    )
    const cred = await run(
      Effect.gen(function* () {
        return yield* (yield* AuthStore).get("openai")
      }),
    )
    const onDisk = JSON.parse(readFileSync(authPath(), "utf8"))
    expect(cred?.type).toBe("oauth")
    if (cred?.type === "oauth") expect(cred.installationId).toEqual(expect.any(String))
    expect(onDisk.openai.installationId).toEqual(expect.any(String))
  })

  it("reads the legacy flat-string auth.json as an api_key", async () => {
    mkdirSync(join(home, ".efferent"), { recursive: true })
    writeFileSync(authPath(), JSON.stringify({ google: "g-key" }))
    const cred = await run(
      Effect.gen(function* () {
        return yield* (yield* AuthStore).get("google")
      }),
    )
    expect(cred).toEqual({ type: "api_key", key: "g-key" })
  })

  it("returns a non-expired OAuth access token without refreshing", async () => {
    const key = await run(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.setOAuth("anthropic", {
          access: "fresh-access",
          refresh: "ref",
          expires: Date.now() + 60 * 60 * 1000, // 1h out → no refresh
        })
        return yield* auth.resolveKey("anthropic")
      }),
    )
    expect(key && Redacted.value(key)).toBe("fresh-access")
  })
})
