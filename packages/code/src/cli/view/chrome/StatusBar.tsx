import { Show } from "solid-js"
import {
  cachePercent,
  contextPercent,
  formatTokens,
  gaugeBar,
  gaugeSeverity,
  prettyCwd,
  statusHint,
} from "../../presentation/statusBar.js"
import { composerMode } from "../../presentation/slashPalette.js"
import { tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * Status bar, agy two-zone: a **left contextual hint** (`? for shortcuts` /
 * `esc to cancel` / `↑ to edit queued` / a transient note — see `statusHint`)
 * and a **right info readout** (`model [effort] [+roles] · gauge % used/window ·
 * cache% · storage · cwd`). The gauge speaks louder as the window fills
 * (`gaugeSeverity`: muted → warn at 70% → critical at 90%, when `:handoff` stops
 * being optional). The vim mode/pane keys live in the `?` shortcuts overlay.
 */
export const StatusBar = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const s = () => store.status()
  const st = () => store.stats()
  const severity = () => gaugeSeverity(st().inputTokens, st().contextWindow)
  const gaugeColor = () =>
    severity() === "critical"
      ? tokens.state.error
      : severity() === "warn"
        ? tokens.state.running
        : tokens.text.muted
  const pct = () => contextPercent(st().inputTokens, st().contextWindow)
  const cache = () => cachePercent(st().cacheReadTokens, st().inputTokens)
  const usage = () =>
    `${formatTokens(st().inputTokens)}/${formatTokens(st().contextWindow)}`
  const hint = () =>
    statusHint({
      busy: store.busy(),
      overlayOpen: store.overlay().kind !== "none",
      queuedCount: store.queued().length,
      // A `:`/`/` line being composed reads "esc to cancel", matching the caret
      // recolour + the menu below — not the idle "? for shortcuts".
      composing: store.focus() === "input" && composerMode(store.input()) !== "message",
      note: store.note(),
    })
  // A live note (theme switched · working in agent …) speaks in the running
  // colour; the resting hints stay dim so they don't compete with the rail.
  const hintColor = () => (store.note() ? tokens.state.running : tokens.text.dim)

  return (
    // No surface fill — agy's status bar is plain text on the terminal background
    // (a filled bar reads as a heavy band under the borderless bottom chrome).
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={hintColor()} wrapMode="none">{hint()}</text>
      <box flexDirection="row">
        <text fg={tokens.accent.conversation}>{s().modelId}</text>
        <Show when={s().effort}>
          <text fg={tokens.text.muted}>{` · `}</text>
          <text fg={tokens.accent.side}>{s().effort}</text>
        </Show>
        <Show when={s().roles}>
          <text fg={tokens.text.dim}>{` · ${s().roles}`}</text>
        </Show>
        <text fg={gaugeColor()}>
          {`  ${gaugeBar(st().inputTokens, st().contextWindow, 8)}${pct() !== undefined ? ` ${pct()}%` : ""}`}
        </text>
        <text fg={tokens.text.muted}>{` ${usage()}`}</text>
        <Show when={cache() !== undefined && cache()! > 0}>
          <text fg={tokens.text.dim}>{` · ${cache()}% cached`}</text>
        </Show>
        <Show when={severity() === "critical"}>
          <text fg={tokens.state.error}>{`  :handoff`}</text>
        </Show>
        <text fg={tokens.text.muted}>{`  ${s().storage}`}</text>
        <text fg={tokens.text.muted}>{`  ${prettyCwd(s().cwd)}`}</text>
      </box>
    </box>
  )
}
