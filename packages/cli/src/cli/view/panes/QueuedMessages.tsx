import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { glyph, tokens } from "../../state/theme.js"
import { truncate } from "../ui/index.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The pending message queue (agy-style): messages typed while a turn runs show
 * as a dim `▸ …` list just above the input fence, draining in order as turns
 * finish. `↑` on an empty composer pulls the most-recent one back to edit (see
 * `keys/dispatch.ts:inputKey`); the status bar flips its hint to say so. Hidden
 * when nothing is queued.
 */
export const QueuedMessages = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const dims = useTerminalDimensions()
  return (
    <Show when={store.queued().length > 0}>
      <box flexDirection="column" flexShrink={0}>
        <For each={store.queued()}>
          {(text) => (
            <text fg={tokens.text.dim} wrapMode="none">
              {`${glyph.queued} ${truncate(text.replace(/\n+/g, " "), Math.max(1, dims().width - 2))}`}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
