import { Show } from "solid-js"
import {
  cachePercent,
  contextPercent,
  formatTokens,
  gaugeBar,
  gaugeSeverity,
  prettyCwd,
} from "../../presentation/statusBar.js"
import { tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * Status bar: `model [effort] [+roles] · gauge % used/window · cache% · storage · cwd`
 * (+ an ephemeral busy note). The gauge speaks louder as the window fills
 * (`gaugeSeverity`: muted → warn at 70% → critical at 90%, when `:handoff`
 * stops being optional) and the cache line is the provider-caching story in
 * one number. The vim mode/pane live in the keybind box, never here.
 */
export const StatusBar = (props: { ctx: TuiContext }) => {
  const s = () => props.ctx.store.status()
  const st = () => props.ctx.store.stats()
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

  return (
    <box flexDirection="row" justifyContent="space-between" backgroundColor={tokens.status.bg} flexShrink={0}>
      <box flexDirection="row">
        <text fg={tokens.accent.conversation}>{s().modelId}</text>
        <Show when={s().effort}>
          <text fg={tokens.text.muted}>{` · `}</text>
          <text fg={tokens.accent.side}>{s().effort}</text>
        </Show>
        <Show when={s().roles}>
          <text fg={tokens.text.dim}>{` ${s().roles}`}</text>
        </Show>
        <text fg={gaugeColor()}>
          {`  ${gaugeBar(st().inputTokens, st().contextWindow, 8)}${pct() !== undefined ? ` ${pct()}%` : ""}`}
        </text>
        <text fg={tokens.text.muted}>{` ${usage()}`}</text>
        <Show when={cache() !== undefined && cache()! > 0}>
          <text fg={tokens.text.dim}>{` · ${cache()}% cached`}</text>
        </Show>
        <Show when={severity() === "critical"}>
          <text fg={tokens.state.error}>{`  :handoff to fold`}</text>
        </Show>
        <Show when={props.ctx.store.note()}>
          <text fg={tokens.state.running}>{`  · ${props.ctx.store.note()}`}</text>
        </Show>
      </box>
      <box flexDirection="row">
        <text fg={tokens.text.muted}>{s().storage}</text>
        <text fg={tokens.text.muted}>{`  ${prettyCwd(s().cwd)}`}</text>
      </box>
    </box>
  )
}
