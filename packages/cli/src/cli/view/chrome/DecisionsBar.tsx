import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { glyph, tokens } from "../../state/theme.js"
import { truncate } from "../ui/index.js"
import type { Decision, TuiContext } from "../../state/store.js"

/**
 * The "decisions need you" roster — a compact passive indicator in the agy
 * bottom chrome (between the pending queue and the input fence). It surfaces
 * `needs_human` events: a header `⚠ N decisions need you`, then one attributed
 * line per pending decision (`⚠ <attribution> · <reason>`). The interactive ASK
 * already gets the inline approval sheet; this is the roster — especially for
 * PARKED (headless/unattended) decisions a human only sees when they attach.
 *
 * Borderless, token-driven (the warn glyph + the `running`/yellow state colour,
 * the same accent the status bar uses for the `:handoff` nudge). Hidden entirely
 * when there are no pending decisions. Not a floating modal — the ask owns that.
 */
const attribution = (d: Decision): string => {
  // Prefer the most specific locator the producer gave us: the scoped folder,
  // else the tool, else the session — so the human knows WHICH agent/where.
  const who = d.folder ?? d.tool ?? d.sessionId
  const tag = d.parked ? "parked" : "asking"
  return who !== undefined ? `${who} (${tag})` : tag
}

export const DecisionsBar = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const dims = useTerminalDimensions()
  const list = () => store.decisions()
  const header = () => {
    const n = list().length
    return `${glyph.warn} ${n} decision${n === 1 ? "" : "s"} need you`
  }
  return (
    <Show when={list().length > 0}>
      <box flexDirection="column" flexShrink={0} marginTop={1}>
        <text fg={tokens.state.running} wrapMode="none">
          {header()}
        </text>
        <For each={list()}>
          {(d) => (
            <text fg={tokens.text.dim} wrapMode="none">
              {`  ${glyph.warn} ${truncate(
                `${attribution(d)} · ${d.reason.replace(/\n+/g, " ")}`,
                Math.max(1, dims().width - 4),
              )}`}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
