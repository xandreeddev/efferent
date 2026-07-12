import { Effect, Fiber, Match, Option } from "effect"
import { AuthStore, ProviderId, Shell } from "@xandreed/engine"
import type { Credential } from "@xandreed/engine"
import {
  beginAnthropicOAuth,
  beginOpenAiCodexOAuth,
  exchangeAnthropicCode,
  exchangeOpenAiCodexCode,
  parseAuthorizationInput,
} from "@xandreed/providers"
import {
  loginSetOAuthStatus,
  oauthStep,
  openLogin,
} from "../presentation/loginFlow.js"
import type { LoginAdvance, LoginFlow, ProviderStatus, SmithProvider } from "../presentation/loginFlow.js"
import { openSelect } from "../presentation/selectBox.js"
import { browserCommand, startCallbackServer } from "../login/oauthServer.js"
import type { SmithTuiContext } from "../state/store.js"

/**
 * The effectful driver over the pure `loginFlow` machine: reads statuses,
 * persists credentials, and runs the anthropic OAuth dance — a loopback
 * callback server RACING a pasted redirect URL, with the CSRF check
 * (`state === verifier`) in front of the exchange either way.
 */

const SMITH_PROVIDERS: ReadonlyArray<SmithProvider> = [
  "anthropic",
  "openai",
  "google",
  "opencode",
]

const readStatuses: Effect.Effect<ReadonlyArray<ProviderStatus>, never, AuthStore> =
  Effect.flatMap(AuthStore, (store) =>
    Effect.map(
      store.all.pipe(Effect.orElseSucceed(() => new Map<string, Credential>())),
      (all) =>
        SMITH_PROVIDERS.map((provider) => {
          const credential =
            provider === "openai"
              ? all.get("openai-codex") ?? all.get("openai")
              : all.get(provider)
          return {
            provider,
            configured: Option.map(Option.fromNullable(credential), (c) => c.type),
          }
        }),
    ),
  )

const backHome = (ctx: SmithTuiContext, notice: string): Promise<void> =>
  ctx
    .run(
      Effect.map(readStatuses, (statuses) => {
        ctx.store.setOverlay({ kind: "login", flow: openLogin(statuses) })
        ctx.store.setNotice(notice)
      }),
    )
    .then(
      () => undefined,
      () => undefined,
    )

/** `:login` — open the provider manager with live status tags. */
export const openLoginFlow = (ctx: SmithTuiContext): void => {
  void ctx.run(
    Effect.map(readStatuses, (statuses) =>
      ctx.store.setOverlay({ kind: "login", flow: openLogin(statuses) }),
    ),
  )
}

/** Tear down an in-flight OAuth attempt (Esc from the oauth step / exit). */
export const stopOAuthSession = (ctx: SmithTuiContext): void => {
  Option.match(ctx.store.oauth(), {
    onNone: () => undefined,
    onSome: (session) => {
      session.stop()
      ctx.store.setOauth(Option.none())
      return undefined
    },
  })
}

const setFlow = (ctx: SmithTuiContext, flow: LoginFlow): void =>
  ctx.store.setOverlay({ kind: "login", flow })

const finishExchange = (
  ctx: SmithTuiContext,
  provider: SmithProvider,
  code: string,
  verifier: string,
): Effect.Effect<void, never, AuthStore> =>
  (provider === "anthropic"
    ? exchangeAnthropicCode(code, verifier)
    : exchangeOpenAiCodexCode(code, verifier)).pipe(
    Effect.flatMap((tokens) =>
      Effect.flatMap(AuthStore, (store) =>
        store.set(
          ProviderId.make(provider === "openai" ? "openai-codex" : provider),
          { type: "oauth", ...tokens },
        ),
      ),
    ),
    Effect.matchEffect({
      onSuccess: () =>
        Effect.promise(() => backHome(ctx, `${provider}: subscription connected`)),
      onFailure: (error) =>
        Effect.sync(() => {
          const flow = ctx.store.overlay()
          if (flow.kind === "login") {
            setFlow(ctx, loginSetOAuthStatus(flow.flow, `failed: ${error.message.slice(0, 80)}`))
          }
        }),
    }),
  )

/** Start a subscription OAuth: begin → loopback server → browser → wait. */
const startOAuth = (ctx: SmithTuiContext, provider: SmithProvider): void => {
  void ctx.run(
    Effect.gen(function* () {
      const statuses = yield* readStatuses
      const begun = yield* provider === "anthropic"
        ? beginAnthropicOAuth.pipe(Effect.map((value) => ({ ...value, state: value.verifier })))
        : beginOpenAiCodexOAuth
      setFlow(ctx, oauthStep(statuses, provider, begun.authorizeUrl))
      const expectedState = begun.state

      const waiter = yield* Effect.forkDaemon(
        Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startCallbackServer(begun.callbackPort, begun.callbackPath)
            const landed = yield* server.waitForCode
            // CSRF: the redirect must echo OUR verifier as state.
            if (landed.state !== expectedState) {
              yield* Effect.sync(() => {
                const flow = ctx.store.overlay()
                if (flow.kind === "login") {
                  setFlow(ctx, loginSetOAuthStatus(flow.flow, "rejected: state mismatch (CSRF)"))
                }
              })
              return
            }
            yield* finishExchange(ctx, provider, landed.code, begun.verifier)
            yield* Effect.sync(() => ctx.store.setOauth(Option.none()))
          }),
        ),
      )
      ctx.store.setOauth(
        Option.some({
          verifier: begun.verifier,
          state: expectedState,
          stop: () => {
            Effect.runFork(Fiber.interrupt(waiter))
          },
        }),
      )

      // Open the browser; failure is tolerated — the URL is on screen.
      const shell = yield* Shell
      const opened = yield* shell
        .exec(browserCommand(begun.authorizeUrl), { timeoutMs: 10_000 })
        .pipe(Effect.orElseSucceed(() => undefined))
      yield* Effect.sync(() => {
        const flow = ctx.store.overlay()
        if (flow.kind === "login") {
          setFlow(
            ctx,
            loginSetOAuthStatus(
              flow.flow,
              opened === undefined
                ? "Could not open a browser — visit the URL below, then paste the redirect."
                : "Waiting for the browser… (or paste the redirect URL below)",
            ),
          )
        }
      })
    }),
  )
}

/** A manually pasted redirect URL (headless / remote-browser logins). */
const manualRedirect = (ctx: SmithTuiContext, provider: SmithProvider, redirect: string): void => {
  const parsed = parseAuthorizationInput(redirect)
  Option.match(ctx.store.oauth(), {
    onNone: () => ctx.store.setNotice("no OAuth in flight — start again with :login"),
    onSome: (session) =>
      Option.match(parsed.code, {
        onNone: () => ctx.store.setNotice("no code in that paste — copy the FULL redirect URL"),
        onSome: (code) => {
          const stateOk = Option.match(parsed.state, {
            onNone: () => true, // a bare code has no state to check
            onSome: (state) => state === session.state,
          })
          if (!stateOk) {
            ctx.store.setNotice("rejected: state mismatch (CSRF)")
            return
          }
          session.stop()
          ctx.store.setOauth(Option.none())
          void ctx.run(finishExchange(ctx, provider, code, session.verifier))
        },
      }),
  })
}

/** Route one Enter through the pure machine's outcome. */
export const advanceLogin = (ctx: SmithTuiContext, advance: LoginAdvance): void => {
  Match.value(advance).pipe(
    Match.when({ kind: "flow" }, (a) => setFlow(ctx, a.flow)),
    Match.when({ kind: "apiKey" }, (a) => {
      void ctx
        .run(
          Effect.flatMap(AuthStore, (store) =>
            store.set(ProviderId.make(a.provider), { type: "api_key", key: a.key }),
          ),
        )
        .then(
          () => backHome(ctx, `${a.provider}: api key saved`),
          () => backHome(ctx, `${a.provider}: SAVE FAILED`),
        )
    }),
    Match.when({ kind: "startOAuth" }, (a) => startOAuth(ctx, a.provider)),
    Match.when({ kind: "oauthManual" }, (a) => manualRedirect(ctx, a.provider, a.redirect)),
    Match.when({ kind: "done" }, () => ctx.store.closeOverlay()),
    Match.when({ kind: "none" }, () => undefined),
    Match.exhaustive,
  )
}

/** `:logout [provider]` — remove directly, or open the picker. */
export const logout = (ctx: SmithTuiContext, provider: Option.Option<string>): void => {
  Option.match(provider, {
    onSome: (p) => {
      const remove = Effect.flatMap(AuthStore, (store) =>
        p === "openai"
          ? Effect.all(
              [store.remove(ProviderId.make("openai")), store.remove(ProviderId.make("openai-codex"))],
              { discard: true },
            )
          : store.remove(ProviderId.make(p)),
      )
      void ctx
        .run(remove)
        .then(
          () => ctx.store.setNotice(`${p}: credential removed`),
          () => ctx.store.setNotice(`${p}: remove failed`),
        )
    },
    onNone: () => {
      void ctx.run(
        Effect.map(readStatuses, (statuses) => {
          const configured = statuses.filter((s) => Option.isSome(s.configured))
          if (configured.length === 0) {
            ctx.store.setNotice("no providers are logged in")
            return
          }
          ctx.store.setOverlay({
            kind: "select",
            purpose: { tag: "logout" },
            sel: openSelect(
              "Log out of…",
              configured.map((s) => ({
                value: Option.some<string>(s.provider),
                label: s.provider,
                tag: Option.match(s.configured, {
                  onNone: () => undefined,
                  onSome: (kind): string => (kind === "oauth" ? "subscription" : "api key"),
                }),
              })),
            ),
          })
        }),
      )
    },
  })
}
