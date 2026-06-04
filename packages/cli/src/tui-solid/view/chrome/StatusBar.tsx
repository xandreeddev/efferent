import { Show } from "solid-js"
import { homedir } from "node:os"
import { formatTokens } from "../../../tui/statusBar.js"
import { theme } from "../../theme.js"
import type { TuiContext } from "../../state/store.js"

/** Plain ▓░ context gauge (the ANSI version lives in the old statusBar.ts). */
const gaugeStr = (used: number, total: number, width: number): string => {
  if (total <= 0) return "─".repeat(width)
  const filled = Math.max(0, Math.min(width, Math.round((used / total) * width)))
  return "▓".repeat(filled) + "░".repeat(width - filled)
}

const home = (() => {
  try {
    return homedir()
  } catch {
    return ""
  }
})()
const prettyCwd = (cwd: string): string =>
  home !== "" && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd

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
        <text fg={theme.gray}>{`  ${gaugeStr(s().inputTokens, s().contextWindow, 8)} ${tokens()}`}</text>
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
