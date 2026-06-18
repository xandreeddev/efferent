import { Effect, Fiber } from "effect"
import {
  AuthFlow,
  AuthStore,
  ModelRegistry,
  Shell,
  defaultModelForProvider,
  parseModel,
  type AuthData,
  type Provider,
} from "@xandreed/sdk-core"
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
import { transitionToMainModel } from "./onboarding.js"

const PROVIDERS = ["anthropic", "google", "openai", "opencode", "ollama"] as const

const loginStatuses = (auth: AuthData): ReadonlyArray<ProviderStatus> =>
  PROVIDERS.map((p) => ({ provider: p, configured: auth[p]?.type }))

/** Replace the open login overlay's flow (no-op if a different overlay is up). */
const setFlow = (store: TuiStore, flow: LoginFlow): void => {
  const o = store.overlay()
  if (o.kind === "login") {
    store.setOverlay({ kind: "login", flow })
  } else if (o.kind === "onboarding" && o.state.step === "login") {
    store.setOverlay({ kind: "onboarding", state: { ...o.state, flow } })
  }
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
    const o = store.overlay()
    const isOnboarding = o.kind === "onboarding"
    yield* Effect.sync(() => {
      if (!isOnboarding) {
        store.closeOverlay()
      }
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
    if (isOnboarding) {
      yield* transitionToMainModel(store, o.state)
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
    // Onboarding may target the local tier (scope on the run handle); plain
    // `:login` leaves it undefined → the global default.
    const res = yield* auth.setApiKey(provider, key, store.run.getConfigScope()).pipe(Effect.either)
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
    const res = yield* auth.setLocal(provider, baseUrl, store.run.getConfigScope()).pipe(Effect.either)
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
    const tokens = yield* (yield* AuthFlow).exchange(provider, code, verifier)
    yield* auth.setOAuth(provider, tokens, store.run.getConfigScope())
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
    const authFlow = yield* AuthFlow
    if (!(yield* authFlow.supportsOAuth(provider))) {
      yield* Effect.sync(() => {
        store.closeOverlay()
        store.pushBlock({
          kind: "info",
          text: `OAuth subscription login isn't available for ${provider} — use an API key.`,
        })
      })
      return
    }
    const begun = yield* authFlow.begin(provider)
    const server = startCallbackServer(begun.callbackPort, begun.callbackPath)
    const shell = yield* Shell
    yield* shell
      .exec({ command: browserCommand(begun.authorizeUrl), cwd, timeoutMs: 5_000 })
      .pipe(Effect.catchAll(() => Effect.void))
    yield* Effect.sync(() => {
      const o = store.overlay()
      if (o.kind === "login") setFlow(store, loginSetOAuthStatus(o.flow, "waiting for browser login"))
      store.pushBlock({
        kind: "info",
        text: `Opening your browser to log in. If it didn't open, visit:\n${begun.authorizeUrl}`,
      })
    })
    const waiter = Effect.gen(function* () {
      const { code, state } = yield* Effect.promise(() => server.waitForCode)
      // CSRF / authorization-code-injection guard: the callback `state` must echo
      // the PKCE verifier we generated (the protocol uses verifier-as-state). A
      // mismatch means the redirect didn't originate from the login we started, so
      // reject without exchanging the code.
      if (state !== begun.verifier) {
        yield* Effect.sync(() => {
          server.stop()
          store.run.setOAuth(undefined)
          failLogin(store, "OAuth state mismatch — the login callback didn't match this session; run :login again.")
        })
        return
      }
      yield* finishOAuth(store, provider, code, begun.verifier, server.stop)
    })
    const fiber = yield* Effect.forkDaemon(waiter)
    yield* Effect.sync(() => {
      store.run.setOAuth({ verifier: begun.verifier, stop: server.stop, fiber })
    })
  })

/** Manual paste of the redirect URL (browser on another machine / no auto-open). */
export const completeOAuthManual = (store: TuiStore, provider: Provider, redirect: string) =>
  Effect.gen(function* () {
    const session = store.run.getOAuth()
    const parsed = yield* (yield* AuthFlow).parseRedirect(redirect)
    if (parsed.code === undefined) {
      yield* Effect.sync(() =>
        store.pushBlock({ kind: "error", text: "couldn't find an authorization code in that input" }),
      )
      return
    }
    // PKCE needs the verifier from the login WE started. Without an in-flight
    // session there's nothing to bind the code to — refuse rather than fall back
    // to a pasted `state` as the verifier (which would defeat PKCE entirely).
    if (session === undefined) {
      yield* Effect.sync(() =>
        store.pushBlock({
          kind: "error",
          text: "no in-flight login to complete — run :login again, then paste the redirect.",
        }),
      )
      return
    }
    // When the pasted redirect carries a `state`, it must echo our verifier.
    if (parsed.state !== undefined && parsed.state !== session.verifier) {
      yield* Effect.sync(() =>
        store.pushBlock({
          kind: "error",
          text: "OAuth state mismatch — that redirect doesn't match this login; run :login again.",
        }),
      )
      return
    }
    yield* Fiber.interrupt(session.fiber)
    yield* finishOAuth(store, provider, parsed.code, session.verifier, session.stop)
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
