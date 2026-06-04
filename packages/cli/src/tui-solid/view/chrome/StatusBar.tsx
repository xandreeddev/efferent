import { Show } from "solid-js"
import { formatTokens, gaugeBar, prettyCwd } from "../../presentation/statusBar.js"
import { theme } from "../../theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * Status bar: `model · tokens · storage · cwd` (+ an ephemeral busy note).
 * The vim mode/pane live in the keybind box, never here — same split as the
 * old `renderStatusBar`.
 */
export const StatusBar = (props: { ctx: TuiContext }) => {
  const s = () => props.ctx.store.status()
  const tokens = () =>
    `${formatTokens(s().inputTokens)} (${formatTokens(s().cacheReadTokens)} cached) / ${formatTokens(s().contextWindow)}`

  return (
    <box flexDirection="row" justifyContent="space-between" backgroundColor="#1f2430" flexShrink={0}>
      <box flexDirection="row">
        <text fg={theme.accent.conversation}>{s().modelId}</text>
        <Show when={s().effort}>
          <text fg={theme.gray}>{` · `}</text>
          <text fg={theme.accent.side}>{s().effort}</text>
        </Show>
        <text fg={theme.gray}>{`  ${gaugeBar(s().inputTokens, s().contextWindow, 8)} ${tokens()}`}</text>
        <Show when={props.ctx.store.note()}>
          <text fg={theme.tool.running}>{`  · ${props.ctx.store.note()}`}</text>
        </Show>
      </box>
      <box flexDirection="row">
        <text fg={theme.gray}>{s().storage}</text>
        <text fg={theme.gray}>{`  ${prettyCwd(s().cwd)}`}</text>
      </box>
    </box>
  )
}
