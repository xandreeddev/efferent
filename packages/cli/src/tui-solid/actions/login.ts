import { Effect, Fiber } from "effect"
import {
  AuthStore,
  ModelRegistry,
  Shell,
  defaultModelForProvider,
  parseModel,
  type AuthData,
  type Provider,
} from "@efferent/core"
import {
  ANTHROPIC_CALLBACK_PORT,
  OPENAI_CALLBACK_PORT,
  anthropicAuthorizeUrl,
  exchangeAnthropicCode,
  exchangeOpenAiCode,
  generatePkce,
  openaiAuthorizeUrl,
  parseAuthorizationInput,
} from "@efferent/adapters"
import { browserCommand, startCallbackServer } from "../../login/oauthServer.js"
import {
  openLogin,
  loginAdvance,
  loginSetOAuthStatus,
  type LoginFlow,
  type ProviderStatus,
} from "../presentation/loginFlow.js"
import { formatFullError } from "../util/errorFormat.js"
import type { TuiContext, TuiStore } from "../state/store.js"
import { applyModelSelection } from "./model.js"

const PROVIDERS = ["anthropic", "google", "openai", "opencode", "ollama"] as const

const loginStatuses = (auth: AuthData): ReadonlyArray<ProviderStatus> =>
  PROVIDERS.map((p) => ({ provider: p, configured: auth[p]?.type }))

/** Replace the open login overlay's flow (no-op if a different overlay is up). */
const setFlow = (store: TuiStore, flow: LoginFlow): void => {
  if (store.overlay().kind === "login") store.setOverlay({ kind: "login", flow })
}

/** Open `:login`, tagging which providers are already configured. */
export const openLoginFlow = (store: TuiStore) =>
  Effect.gen(function* () {
    const all = yield* (yield* AuthStore).all
    yield* Effect.sync(() => store.setOverlay({ kind: "login", flow: openLogin(loginStatuses(all)) }))
  })

/**
 * Post-login: if the active model's provider has no credential, switch to the
 * just-configured provider's default model; confirm on the rail and close the
 * overlay. Lifted from `tui.ts`'s `afterLogin`.
 */
const afterLogin = (store: TuiStore, provider: Provider, how: string) =>
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    const auth = yield* AuthStore
    const cur = yield* registry.current
    const curHasCred = (yield* auth.get(cur.provider)) !== undefined
    yield* Effect.sync(() => {
      store.closeOverlay()
      store.pushBlock({ kind: "info", text: `✓ logged in to ${provider} (${how})` })
    })
    if (!curHasCred) {
      const defaultModel =
        provider === "openai" && how === "subscription"
          ? "openai:gpt-5.5"
          : defaultModelForProvider(provider)
      const { provider: p, modelId } = parseModel(defaultModel)
      yield* applyModelSelection(store, { provider: p, modelId, displayName: modelId, contextWindow: 0 })
    }
  })

const failLogin = (store: TuiStore, message: string): void => {
  store.closeOverlay()
  store.pushBlock({ kind: "error", text: `login failed: ${message}` })
}

/** Persist an API key, then run the post-login steps. */
export const commitApiKey = (store: TuiStore, provider: Provider, key: string) =>
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const res = yield* auth.setApiKey(provider, key).pipe(Effect.either)
    if (res._tag === "Left") {
      yield* Effect.sync(() => failLogin(store, res.left.message))
      return
    }
    yield* afterLogin(store, provider, "api key")
  })

/** Persist a local (no-auth) credential, e.g. an Ollama base URL. */
export const commitLocalUrl = (store: TuiStore, provider: Provider, baseUrl: string) =>
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const res = yield* auth.setLocal(provider, baseUrl).pipe(Effect.either)
    if (res._tag === "Left") {
      yield* Effect.sync(() => failLogin(store, res.left.message))
      return
    }
    yield* afterLogin(store, provider, "local")
  })

/** Exchange the OAuth code for tokens, persist, run post-login; stops the server. */
const finishOAuth = (
  store: TuiStore,
  provider: Provider,
  code: string,
  verifier: string,
  stop: () => void,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const tokens = yield* (provider === "openai"
      ? exchangeOpenAiCode(code, verifier)
      : exchangeAnthropicCode(code, verifier))
    yield* auth.setOAuth(provider, tokens)
    yield* Effect.sync(() => {
      stop()
      store.run.setOAuth(undefined)
    })
    yield* afterLogin(store, provider, "subscription")
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        stop()
        store.run.setOAuth(undefined)
        failLogin(store, formatFullError(e))
      }),
    ),
  )

/**
 * OAuth subscription login: PKCE → open the browser + a loopback callback
 * server, then a forked waiter races the callback against a manually-pasted
 * redirect URL. Lifted from `tui.ts`'s `startOAuthLogin`.
 */
export const startOAuthLogin = (store: TuiStore, cwd: string, provider: Provider) =>
  Effect.gen(function* () {
    if (provider !== "anthropic" && provider !== "openai") {
      yield* Effect.sync(() => {
        store.closeOverlay()
        store.pushBlock({
          kind: "info",
          text: `OAuth subscription login isn't available for ${provider} — use an API key.`,
        })
      })
      return
    }
    const pkce = yield* generatePkce()
    const url = provider === "openai" ? openaiAuthorizeUrl(pkce) : anthropicAuthorizeUrl(pkce)
    const server =
      provider === "openai"
        ? startCallbackServer(OPENAI_CALLBACK_PORT, "/auth/callback")
        : startCallbackServer(ANTHROPIC_CALLBACK_PORT)
    const shell = yield* Shell
    yield* shell
      .exec({ command: browserCommand(url), cwd, timeoutMs: 5_000 })
      .pipe(Effect.catchAll(() => Effect.void))
    yield* Effect.sync(() => {
      const o = store.overlay()
      if (o.kind === "login") setFlow(store, loginSetOAuthStatus(o.flow, "waiting for browser login"))
      store.pushBlock({
        kind: "info",
        text: `Opening your browser to log in. If it didn't open, visit:\n${url}`,
      })
    })
    const waiter = Effect.gen(function* () {
      const { code } = yield* Effect.promise(() => server.waitForCode)
      yield* finishOAuth(store, provider, code, pkce.verifier, server.stop)
    })
    const fiber = yield* Effect.forkDaemon(waiter)
    yield* Effect.sync(() => {
      store.run.setOAuth({ verifier: pkce.verifier, stop: server.stop, fiber })
    })
  })

/** Manual paste of the redirect URL (browser on another machine / no auto-open). */
export const completeOAuthManual = (store: TuiStore, provider: Provider, redirect: string) =>
  Effect.gen(function* () {
    const session = store.run.getOAuth()
    const parsed = parseAuthorizationInput(redirect)
    if (parsed.code === undefined) {
      yield* Effect.sync(() =>
        store.pushBlock({ kind: "error", text: "couldn't find an authorization code in that input" }),
      )
      return
    }
    if (session !== undefined) yield* Fiber.interrupt(session.fiber)
    const verifier = session?.verifier ?? parsed.state ?? ""
    yield* finishOAuth(store, provider, parsed.code, verifier, session?.stop ?? (() => {}))
  })

/** Tear down an in-flight OAuth login (callback server + waiter) on cancel. */
export const stopOAuthSession = (store: TuiStore) =>
  Effect.gen(function* () {
    const sess = store.run.getOAuth()
    if (sess === undefined) return
    yield* Effect.sync(() => sess.stop())
    yield* Fiber.interrupt(sess.fiber)
    yield* Effect.sync(() => {
      store.run.setOAuth(undefined)
    })
  })

/**
 * Dispatch a login Enter: run the pure `loginAdvance`, then perform the side
 * effect its outcome asks for (advance the flow, persist a key/URL, or kick off
 * OAuth). Mirrors the old TUI's `:login` Enter branch.
 */
export const advanceLogin = (ctx: TuiContext, flow: LoginFlow): void => {
  const { store } = ctx
  const outcome = loginAdvance(flow)
  switch (outcome.kind) {
    case "flow":
      setFlow(store, outcome.flow)
      return
    case "apiKey":
      void ctx.run(commitApiKey(store, outcome.provider, outcome.key))
      return
    case "startOAuth":
      setFlow(store, outcome.flow)
      void ctx.run(startOAuthLogin(store, store.status().cwd, outcome.provider))
      return
    case "oauthManual":
      void ctx.run(completeOAuthManual(store, outcome.provider, outcome.redirect))
      return
    case "localUrl":
      void ctx.run(commitLocalUrl(store, outcome.provider, outcome.baseUrl))
      return
    case "none":
      return
  }
}

/** `:logout <provider>` — forget a provider's credential. */
export const logout = (store: TuiStore, arg: string | undefined) =>
  Effect.gen(function* () {
    const provider = (arg ?? "").trim().toLowerCase()
    if (!PROVIDERS.includes(provider as Provider)) {
      yield* Effect.sync(() =>
        store.pushBlock({
          kind: "info",
          text: `usage: :logout <${PROVIDERS.join("|")}>`,
        }),
      )
      return
    }
    const auth = yield* AuthStore
    const res = yield* auth.remove(provider as Provider).pipe(Effect.either)
    yield* Effect.sync(() =>
      store.pushBlock(
        res._tag === "Left"
          ? { kind: "error", text: `logout failed: ${res.left.message}` }
          : { kind: "info", text: `logged out of ${provider}` },
      ),
    )
  })
