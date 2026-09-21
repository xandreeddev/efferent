import { Deferred, Effect, Option } from "effect"
import { AuthStore, HarnessError, ProviderId } from "@xandreed/core"
import { beginAnthropicOAuth, beginOpenAiCodexOAuth, exchangeAnthropicCode, exchangeOpenAiCodexCode, LocalAuthStoreLive, parseAuthorizationInput } from "@xandreed/plugin-models"
import { spawnBounded } from "@xandreed/plugin-tools-local"
import type { TuiCommand, TuiState } from "@xandreed/tui"

const invalid = (message: string) => new HarnessError({ code: "login.failed", message })
export const loginCommand = (workspace: string, home: string, launch: (state: TuiState, effect: Effect.Effect<void, HarnessError>) => void, onConnected?: () => Effect.Effect<void, HarnessError>): TuiCommand => {
  const store = <A, E>(effect: Effect.Effect<A, E, AuthStore>) => effect.pipe(Effect.provide(LocalAuthStoreLive(workspace, home, ".efferent/runtime", ".efferent")), Effect.mapError((error) => invalid(String(error))))
  const apiKey = (provider: string, state: TuiState) => state.setOverlay({ kind: "edit", title: `API key · ${provider}`, value: "", secret: true,
    save: (key) => launch(state, key.trim().length === 0 ? Effect.fail(invalid("Enter an API key")) : store(AuthStore.pipe(Effect.flatMap((auth) => auth.set(ProviderId.make(provider), { type: "api_key", key: key.trim() })))).pipe(Effect.tap(() => Effect.sync(() => {
      state.setOverlay({ kind: "none" }); state.setNotice(`Connected ${provider}. Use /model provider:model to select a model.`)
    })), Effect.zipRight(onConnected?.() ?? Effect.void))),
  })
  const oauth = (provider: "openai" | "anthropic", state: TuiState) => Effect.scoped(Effect.gen(function* () {
    const begun = yield* provider === "openai" ? beginOpenAiCodexOAuth : beginAnthropicOAuth.pipe(Effect.map((value) => ({ ...value, state: value.verifier })))
    const landed = yield* Deferred.make<string>()
    const cancelled = yield* Deferred.make<void>()
    const cancel = () => { Effect.runSync(Deferred.succeed(cancelled, undefined)) }
    const accept = (code: string, token: string) => token === begun.state && code.length > 0
    const callback = yield* Effect.acquireRelease(Effect.try({
      try: () => Bun.serve({ hostname: "127.0.0.1", port: begun.callbackPort, fetch: (request) => {
        const url = new URL(request.url)
        if (url.pathname !== begun.callbackPath) return new Response("Not found", { status: 404 })
        const code = url.searchParams.get("code") ?? ""
        if (!accept(code, url.searchParams.get("state") ?? "")) return new Response("Invalid authorization response", { status: 400 })
        Effect.runSync(Deferred.succeed(landed, code))
        return new Response("Authorization received. Return to Efferent to finish connecting.", { headers: { "content-type": "text/plain" } })
      } }),
      catch: (error) => invalid(String(error)),
    }), (server) => Effect.sync(() => server.stop(true))).pipe(Effect.option)
    const paste = () => state.setOverlay({ kind: "edit", title: "Paste the full callback URL", value: "", secret: true, onClose: cancel,
      save: (text) => {
        const parsed = parseAuthorizationInput(text)
        if (Option.isSome(parsed.code) && Option.isSome(parsed.state) && accept(parsed.code.value, parsed.state.value)) {
          Effect.runSync(Deferred.succeed(landed, parsed.code.value))
        } else state.setNotice("The callback must include this login's code and state. Start again if it expired.")
      },
    })
    state.setOverlay({ kind: "menu", title: `Connect ${provider} subscription`, onClose: cancel, rows: [
      { label: "Open authorization page", detail: begun.authorizeUrl, select: () => launch(state, spawnBounded(["xdg-open", begun.authorizeUrl], workspace, 10_000).pipe(Effect.mapError((error) => invalid(error.message)), Effect.tap((result) => Effect.sync(() => state.setNotice(result.exitCode === 0 ? "Waiting for browser authorization…" : `Open this URL: ${begun.authorizeUrl}`))), Effect.asVoid)) },
      { label: "Paste callback URL", detail: Option.isSome(callback) ? "For a remote browser or manual completion" : "Callback port unavailable; use manual completion", select: paste },
      { label: "Cancel", detail: "", select: () => state.setOverlay({ kind: "none" }) },
    ] })
    const code = yield* Effect.race(Deferred.await(landed).pipe(Effect.map(Option.some)), Deferred.await(cancelled).pipe(Effect.as(Option.none<string>()))).pipe(
      Effect.timeoutFail({ duration: "5 minutes", onTimeout: () => invalid("Login expired. Start /login again.") }),
    )
    if (Option.isNone(code)) return
    const tokens = yield* (provider === "openai" ? exchangeOpenAiCodexCode(code.value, begun.verifier) : exchangeAnthropicCode(code.value, begun.verifier)).pipe(Effect.mapError((error) => invalid(error.message)))
    yield* store(AuthStore.pipe(Effect.flatMap((auth) => auth.set(ProviderId.make(provider === "openai" ? "openai-codex" : provider), { type: "oauth", ...tokens }))))
    state.setOverlay({ kind: "none" }); state.setNotice(`${provider} subscription connected. Use /model to select a model.`)
    if (onConnected !== undefined) yield* onConnected()
  }))
  const providerMenu = (provider: string, state: TuiState) => state.setOverlay({ kind: "menu", title: `Connect ${provider}`, rows: [
    { label: "API key", detail: "Stored locally; input is masked", select: () => apiKey(provider, state) },
    ...(["openai", "anthropic"].includes(provider) ? [{ label: "Subscription login", detail: "Browser authorization with PKCE", select: () => launch(state, oauth(provider as "openai" | "anthropic", state)) }] : []),
  ] })
  return { name: "login", description: "Connect a provider with an API key or subscription", run: (argument, state) => Effect.sync(() => {
    if (argument.length > 0) { providerMenu(argument, state); return }
    state.setOverlay({ kind: "menu", title: "Connect a provider", rows: ["openai", "anthropic", "google", "opencode"].map((provider) => ({ label: provider, detail: "", select: () => providerMenu(provider, state) })) })
  }) }
}
