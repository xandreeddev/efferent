import { Effect } from "effect"
import { SettingsStore, Shell } from "@efferent/core"
import { browserCommand } from "../../login/oauthServer.js"
import type { TuiStore } from "../state/store.js"

/**
 * `:traces` / `:dashboard` — open the local Grafana (the otel-lgtm stack) at the
 * right view. Navigation lives in Grafana over Tempo (per-conversation,
 * per-message, full waterfall); the CLI just deep-links into it, reusing the
 * same browser-open + `Shell.exec` path as the OAuth login flow.
 */

const DEFAULT_GRAFANA = "http://localhost:3000"

/**
 * Whether telemetry is exporting this session. Mirrors `main.ts`'s boot check:
 * an env opt-in or the persisted `telemetry` setting. (A mid-session
 * `:set telemetry on` only takes effect on the next launch — the tracer layer
 * binds at boot — so the env vars are the authoritative live signal.)
 */
const telemetryActive = (settingsTelemetry: boolean | undefined): boolean =>
  process.env["EFFERENT_OTLP"] !== undefined ||
  process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] !== undefined ||
  settingsTelemetry === true

const openUrl = (store: TuiStore, url: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    yield* shell
      .exec({ command: browserCommand(url), cwd: store.status().cwd, timeoutMs: 5_000 })
      .pipe(Effect.catchAll(() => Effect.void))
    yield* Effect.sync(() => store.pushBlock({ kind: "info", text: `opening ${url}` }))
  })

/** Open the per-conversation drill-down, filtered to the active conversation. */
export const openConversationTraces = (store: TuiStore, conversationId: string) =>
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).get()
    if (!telemetryActive(settings.telemetry)) {
      yield* Effect.sync(() =>
        store.toast("traces unavailable — enable telemetry: :set telemetry on (or EFFERENT_OTLP=1)"),
      )
      return
    }
    const base = settings.grafanaUrl ?? DEFAULT_GRAFANA
    const url =
      `${base}/d/efferent-conversation/efferent-conversation` +
      `?var-conversation=${encodeURIComponent(conversationId)}`
    yield* openUrl(store, url)
  })

/** Open the global fleet-health dashboard (RED / cost / cache / tools). */
export const openFleetDashboard = (store: TuiStore) =>
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).get()
    if (!telemetryActive(settings.telemetry)) {
      yield* Effect.sync(() =>
        store.toast("export is off (:set telemetry on) — the dashboard may be empty"),
      )
    }
    const base = settings.grafanaUrl ?? DEFAULT_GRAFANA
    yield* openUrl(store, `${base}/d/efferent-fleet/efferent-fleet`)
  })
