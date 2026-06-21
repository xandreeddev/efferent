import { For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { glyph, tokens } from "../../state/theme.js"
import { KeyHints, Rule } from "../../view/ui/atoms.js"
import {
  buildFleetRows,
  dashboardMetricsSegments,
  statusGlyph,
  type DashboardRow,
} from "../presentation/dashboardView.js"
import { handleDashboardKey, type DashboardActions } from "../keys.js"
import type { DashboardStore } from "../state/dashboardStore.js"

const statusColor = (status: string): string =>
  status === "running"
    ? tokens.state.running
    : status === "ok"
      ? tokens.state.ok
      : status === "error"
        ? tokens.state.error
        : tokens.text.dim

const HINTS = [
  { key: "j/k", label: "move" },
  { key: "↵", label: "attach" },
  { key: "n", label: "new fleet" },
  { key: "s", label: "stop" },
  { key: "i", label: "interrupt" },
  { key: "⇥", label: "fold" },
  { key: "D", label: "shutdown" },
  { key: "q", label: "quit" },
]

/**
 * The k9s-style control dashboard view: a metrics strip, the fleets → agents
 * tree (deployments → pods), and the "messages flying" stream, with an operator
 * key legend. Reads the `DashboardStore` signals; all the row/segment shaping is
 * the pure `dashboardView` model.
 */
export const Dashboard = (props: {
  ctx: { store: DashboardStore; width: number; actions: DashboardActions }
}) => {
  const store = props.ctx.store
  useKeyboard((key) => handleDashboardKey({ store, actions: props.ctx.actions }, key))
  const rows = (): ReadonlyArray<DashboardRow> =>
    buildFleetRows(store.sessions(), store.collapsed())

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Header + metrics strip */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={tokens.accent.conversation} wrapMode="none">{`${glyph.wordmark}efferent control`}</text>
        <Show when={store.metrics() !== undefined}>
          <text fg={tokens.text.dim} wrapMode="none">
            {`  ${dashboardMetricsSegments(store.metrics()!).join("  ·  ")}`}
          </text>
        </Show>
      </box>
      <Rule width={props.ctx.width} />

      <Show when={store.needsLogin()}>
        <text fg={tokens.state.error}>
          {"no provider configured — run `efferent` to onboard (login), then this daemon serves it"}
        </text>
      </Show>

      {/* Fleets → agents (left) + messages flying (right) */}
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" flexGrow={1} flexShrink={1}>
          <text fg={tokens.text.dim}>{` ${glyph.fleet} fleets → agents`}</text>
          <scrollbox flexGrow={1}>
            <For each={rows()}>
              {(row, i) => {
                const selected = i() === store.cursor()
                const s = row.display.summary
                const marker = selected ? glyph.pointer : " "
                const label =
                  row.display.kind === "fleet"
                    ? `${s.title ?? "fleet"}${s.model !== undefined ? `  [${s.model}]` : ""}`
                    : `${s.title ?? s.folder}`
                return (
                  <box flexDirection="row">
                    <text fg={tokens.marker.cursor} wrapMode="none">{`${marker} `}</text>
                    <text fg={tokens.text.dim} wrapMode="none">{row.rail}</text>
                    <text fg={statusColor(s.status)} wrapMode="none">{`${statusGlyph(s.status)} `}</text>
                    <text
                      fg={selected ? tokens.text.default : tokens.text.default}
                      wrapMode="none"
                    >
                      {label}
                    </text>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </box>

        <text fg={tokens.text.dim}>{"  │  "}</text>

        <box flexDirection="column" width={48} flexShrink={0}>
          <text fg={tokens.text.dim}>{"  ✦ messages flying"}</text>
          <scrollbox flexGrow={1}>
            <For each={store.messages()}>
              {(m) => (
                <box flexDirection="row">
                  <text fg={tokens.marker.handoff} wrapMode="none">{`${m.from}: `}</text>
                  <text fg={tokens.text.default}>{m.content}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      </box>

      <Rule width={props.ctx.width} />
      <box flexDirection="row" flexShrink={0}>
        <KeyHints hints={HINTS} />
        <Show when={store.note() !== undefined}>
          <text fg={tokens.text.dim} wrapMode="none">{`   ${store.note()}`}</text>
        </Show>
      </box>
    </box>
  )
}
