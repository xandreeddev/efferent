import { For, Show } from "solid-js"
import { BRAND, glyph, tokens } from "../../theme.js"

/**
 * The efferent lockup, re-homed from the old line: the letterspaced wordmark
 * with the `{ smith }` package tag, the brand-triad gradient underline
 * (ember → chartreuse → verdigris — theme-independent, the mark is a stable
 * identity), and the tagline. `compact` drops the tagline.
 */

const WORDMARK = "E F F E R E N T"
const TAG = " { smith }"
const TAGLINE = "refine → lock → forge — the spec-driven coder"

export const Logo = (props: { compact?: boolean }) => {
  const barWidth = WORDMARK.length + TAG.length
  const third = Math.floor(barWidth / 3)
  const segments = [
    { fg: BRAND.ember, len: third },
    { fg: BRAND.chartreuse, len: third },
    { fg: BRAND.verdigris, len: barWidth - third * 2 },
  ]
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row">
        <text fg={tokens.text.bright} wrapMode="none">{WORDMARK}</text>
        <text fg={tokens.text.dim} wrapMode="none">{" { "}</text>
        <text fg={BRAND.chartreuse} wrapMode="none">smith</text>
        <text fg={tokens.text.dim} wrapMode="none">{" }"}</text>
      </box>
      <box flexDirection="row">
        <For each={segments}>
          {(seg) => (
            <text fg={seg.fg} wrapMode="none">{glyph.logoBar.repeat(seg.len)}</text>
          )}
        </For>
      </box>
      <Show when={props.compact !== true}>
        <text fg={tokens.text.dim} wrapMode="none">{TAGLINE}</text>
      </Show>
    </box>
  )
}
