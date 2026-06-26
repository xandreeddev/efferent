import { For, Show } from "solid-js"
import type { ModelRole } from "@xandreed/sdk-core"
import {
  cachePercent,
  contextPercent,
  formatTokens,
  gaugeBar,
  gaugeSeverity,
  prettyCwd,
  type RoleEntry,
  statusHint,
} from "../../presentation/statusBar.js"
import { composerMode } from "../../presentation/slashPalette.js"
import { glyph, tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * Status bar — **two rows**, agy-quiet (plain text, no fill). Row 1 is the live
 * metrics: a left contextual hint (`? for shortcuts` / `esc to cancel` / … —
 * `statusHint`) and a right readout (gauge % used/window · cache% · storage ·
 * cwd; the gauge reddens past 70/90% via `gaugeSeverity`, where `:handoff` stops
 * being optional). Row 2 is the **model roles** — general · code · fast with
 * their model ids — and marks the one ACTIVE for the focused agent (the root is
 * `general`; pairing into a sub-agent flips it to that agent's tier). Keys live
 * in the `?` overlay.
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

  const roles = (): ReadonlyArray<RoleEntry> => {
    const r = s().roles
    // Fall back to a lone `general` entry from the status model id, so the bar
    // always shows the active model even before the roles readout is seeded.
    return r !== undefined && r.length > 0
      ? r
      : [{ role: "general", modelId: s().modelId, configured: true }]
  }
  // The role ACTIVE for the agent currently in focus: the root conversation is
  // `general`; with a sub-agent preview open, that agent's tier (from the live
  // fleet member, else general). Nothing the model emits changes this.
  const activeRole = (): ModelRole => {
    const preview = store.nodePreview()
    if (preview === undefined) return "general"
    const member = store.agentState().fleet.find((m) => m.nodeId === preview.nodeId)
    return member?.role ?? "general"
  }

  return (
    // No surface fill — agy's status bar is plain text on the terminal background.
    <box flexDirection="column" flexShrink={0}>
      {/* Row 1 — live metrics. */}
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={hintColor()} wrapMode="none">{hint()}</text>
        <box flexDirection="row">
          <text fg={gaugeColor()}>
            {`${gaugeBar(st().inputTokens, st().contextWindow, 8)}${pct() !== undefined ? ` ${pct()}%` : ""}`}
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
      {/* Row 2 — the three model roles, active one highlighted. */}
      <box flexDirection="row" flexShrink={0}>
        <For each={roles()}>
          {(entry) => {
            const active = () => entry.role === activeRole()
            // Active → accent + a leading dot; a configured follower → muted;
            // a role still following general → dim (it shares general's id).
            const color = () =>
              active()
                ? tokens.accent.conversation
                : entry.configured
                  ? tokens.text.muted
                  : tokens.text.dim
            const isGeneral = () => entry.role === "general"
            return (
              <text fg={color()} wrapMode="none">
                {`${active() ? `${glyph.railDot} ` : "  "}${entry.role} ${entry.modelId}${
                  isGeneral() && s().effort ? ` ${s().effort}` : ""
                }`}
              </text>
            )
          }}
        </For>
      </box>
    </box>
  )
}
