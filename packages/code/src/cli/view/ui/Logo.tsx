import { For, Show } from "solid-js"
import { BRAND, glyph, tokens } from "../../state/theme.js"

/**
 * Package variants of the efferent mark. Each maps to a real workspace package
 * and carries a semantic bracket pair (the brackets *mean* something for that
 * package — `< >` markup/generics, `( )` social, `{ }` modules, `[ ]` lists) +
 * a one-line tagline. `master` is the bare wordmark (no bracket tag).
 */
export type LogoVariant = "master" | "code" | "social" | "sdk" | "evals"

interface VariantSpec {
  readonly pkg?: string
  readonly open?: string
  readonly close?: string
  readonly tagline: string
}

const VARIANTS: Record<LogoVariant, VariantSpec> = {
  master: { tagline: "a coding agent on effect.ts" },
  code: { pkg: "code", open: "<", close: ">", tagline: "the agent loop · TUI · headless modes" },
  social: { pkg: "social", open: "(", close: ")", tagline: "built-in-public content engine" },
  sdk: { pkg: "sdk", open: "{", close: "}", tagline: "ports · adapters · @effect/ai toolkit" },
  evals: { pkg: "evals", open: "[", close: "]", tagline: "colocated, effect-native evals" },
}

/** The wordmark, letterspaced to match the gradient underline width. */
const WORDMARK = "E F F E R E N T"

/**
 * The efferent logo — the locked hybrid lockup: the `EFFERENT` wordmark with an
 * optional `<pkg>` tag inline, a brand-triad gradient underline spanning the
 * whole lockup (ember → chartreuse → verdigris, painted from the fixed `BRAND`
 * triad — theme-independent, so the mark is a stable identity no matter the
 * active theme), and a tagline below. Pass a `variant` to scope it to a package;
 * default is the master mark.
 *
 * `compact` drops the tagline (header / tight contexts). The gradient bar is
 * split into three equal regions over the lockup's character width.
 */
export const Logo = (props: { variant?: LogoVariant; compact?: boolean }) => {
  const spec = () => VARIANTS[props.variant ?? "master"]
  const tagLabel = () => {
    const s = spec()
    return s.pkg !== undefined ? ` ${s.open} ${s.pkg} ${s.close}` : ""
  }
  // Total lockup width in cells = wordmark (15) + the bracket tag, if any.
  const barWidth = () => WORDMARK.length + tagLabel().length
  // Split the bar into ember / chartreuse / verdigris thirds.
  const segments = () => {
    const n = barWidth()
    const a = Math.floor(n / 3)
    const b = Math.floor(n / 3)
    return [
      { fg: BRAND.ember, len: a },
      { fg: BRAND.chartreuse, len: b },
      { fg: BRAND.verdigris, len: n - a - b },
    ]
  }

  return (
    <box flexDirection="column">
      {/* wordmark + inline package tag */}
      <box flexDirection="row">
        <text fg={tokens.text.default} wrapMode="none">
          {WORDMARK}
        </text>
        <Show when={spec().pkg !== undefined}>
          <text fg={tokens.text.dim} wrapMode="none">{` ${spec().open} `}</text>
          <text fg={BRAND.chartreuse} wrapMode="none">{spec().pkg}</text>
          <text fg={tokens.text.dim} wrapMode="none">{` ${spec().close}`}</text>
        </Show>
      </box>
      {/* gradient underline (three equal regions) */}
      <box flexDirection="row">
        <For each={segments()}>
          {(seg) => (
            <text fg={seg.fg} wrapMode="none">
              {glyph.logoBar.repeat(seg.len)}
            </text>
          )}
        </For>
      </box>
      {/* tagline */}
      <Show when={props.compact !== true}>
        <text fg={tokens.text.muted} wrapMode="none">
          {spec().tagline}
        </text>
      </Show>
    </box>
  )
}
