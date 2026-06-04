import { Show } from "solid-js"
import { formatTokens, gaugeBar, prettyCwd } from "../../presentation/statusBar.js"
import { tokens } from "../../presentation/theme/index.js"
import type { TuiContext } from "../../state/store.js"

/**
 * Status bar: `model · tokens · storage · cwd` (+ an ephemeral busy note).
 * The vim mode/pane live in the keybind box, never here — same split as the
 * old `renderStatusBar`.
 */
export const StatusBar = (props: { ctx: TuiContext }) => {
  const s = () => props.ctx.store.status()
  const tokenLabel = () =>
    `${formatTokens(s().inputTokens)} (${formatTokens(s().cacheReadTokens)} cached) / ${formatTokens(s().contextWindow)}`

  return (
    <box flexDirection="row" justifyContent="space-between" backgroundColor={tokens.status.bg} flexShrink={0}>
      <box flexDirection="row">
        <text fg={tokens.accent.conversation}>{s().modelId}</text>
        <Show when={s().effort}>
          <text fg={tokens.text.muted}>{` · `}</text>
          <text fg={tokens.accent.side}>{s().effort}</text>
        </Show>
        <text fg={tokens.text.muted}>{`  ${gaugeBar(s().inputTokens, s().contextWindow, 8)} ${tokenLabel()}`}</text>
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
