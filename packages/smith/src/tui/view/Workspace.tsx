import { For, Show } from "solid-js"
import { glyph, tokens } from "../theme.js"
import type { SmithTuiContext } from "../state/store.js"

/**
 * The idle dashboard — what a persistent session shows between runs: the
 * specs on file, the recent forge history, and the lessons the memory will
 * brief the next run with. All three sections read `store.workspace()`;
 * the runtime refreshes it after every turn/lock/forge.
 */
export const Workspace = (props: { ctx: SmithTuiContext }) => {
  const view = props.ctx.store.workspace
  return (
    <box flexDirection="row" flexGrow={1} marginTop={1}>
      <box flexDirection="column" flexGrow={1}>
        <text fg={tokens.text.dim}>specs</text>
        <Show
          when={view().specs.length > 0}
          fallback={
            <text fg={tokens.state.pending}>
              {"  no specs yet — describe what to build, or :forge <slug>"}
            </text>
          }
        >
          <For each={view().specs}>
            {(spec) => (
              <box flexDirection="row">
                <text
                  fg={spec.status === "locked" ? tokens.state.ok : tokens.state.warn}
                  flexShrink={0}
                >
                  {`  ${spec.status === "locked" ? glyph.pass : glyph.pending} ${spec.slug} `}
                </text>
                <text fg={tokens.text.dim} wrapMode="none">{spec.goal}</text>
              </box>
            )}
          </For>
        </Show>

        <text fg={tokens.text.dim} marginTop={1}>forge runs</text>
        <Show
          when={view().runs.length > 0}
          fallback={<text fg={tokens.state.pending}>{"  (none yet)"}</text>}
        >
          <For each={view().runs}>
            {(run) => (
              <text
                fg={run.accepted ? tokens.state.ok : tokens.state.error}
                wrapMode="none"
              >{`  ${run.text}`}</text>
            )}
          </For>
        </Show>
      </box>

      <box flexDirection="column" width={56} flexShrink={0} marginLeft={2}>
        <text fg={tokens.text.dim}>lessons (fed to the next refine + forge)</text>
        <Show
          when={view().lessons.length > 0}
          fallback={
            <text fg={tokens.state.pending}>{"  none yet — they grow from gate rejections"}</text>
          }
        >
          <For each={view().lessons}>
            {(lesson) => (
              <text fg={tokens.text.muted} wrapMode="word">{`  ${glyph.bullet} ${lesson}`}</text>
            )}
          </For>
        </Show>
      </box>
    </box>
  )
}
