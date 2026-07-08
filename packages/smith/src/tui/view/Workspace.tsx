import { For, Show } from "solid-js"
import { Option } from "effect"
import { BRAND, glyph, tokens } from "../theme.js"
import { Logo } from "./ui/Logo.js"
import type { SmithTuiContext } from "../state/store.js"

/**
 * The idle dashboard — a persistent session's home. Identity first (the
 * lockup), then WHAT'S CONFIGURED (the provider strip — the old line's
 * at-a-glance statuses, re-homed), then the workspace: specs, forge runs,
 * previous sessions (`:resume`), lessons. An UNCONFIGURED workspace shows
 * the onboarding checklist instead — the guided first-run.
 */

const SectionHead = (props: { accent: string; label: string }) => (
  <box flexDirection="row" marginTop={1}>
    <text fg={props.accent} flexShrink={0}>{`${glyph.brand} `}</text>
    <text fg={tokens.text.dim} wrapMode="none">{props.label}</text>
  </box>
)

const ProviderStrip = (props: { ctx: SmithTuiContext }) => {
  const chips = () => props.ctx.store.workspace().providers
  return (
    <box flexDirection="row" flexShrink={0} marginTop={1}>
      <text fg={tokens.text.dim} flexShrink={0}>{"providers  "}</text>
      <For each={chips()}>
        {(chip, index) => (
          <>
            {index() > 0 ? <text fg={tokens.text.dim}>{"  ·  "}</text> : null}
            <text
              fg={Option.isSome(chip.tag) ? tokens.state.ok : tokens.text.dim}
              wrapMode="none"
            >
              {`${Option.isSome(chip.tag) ? glyph.pass : glyph.skip} ${chip.name}`}
            </text>
            <Show when={Option.isSome(chip.tag)}>
              <text fg={tokens.marker.select} wrapMode="none">
                {` ${glyph.activeTag} ${Option.getOrElse(chip.tag, () => "")}`}
              </text>
            </Show>
          </>
        )}
      </For>
    </box>
  )
}

/** The guided first-run: what's missing, and the one command that fixes it. */
const Onboarding = (props: { ctx: SmithTuiContext }) => {
  const roles = props.ctx.store.roles
  return (
    <box flexDirection="column" flexGrow={1} marginTop={1}>
      <box height={1} />
      <Logo />
      <box height={1} />
      <text fg={tokens.text.bright} wrapMode="word">
        {"Welcome — this workspace isn't connected to a model provider yet."}
      </text>
      <box height={1} />
      <box flexDirection="row">
        <text fg={tokens.state.error} flexShrink={0}>{`  ${glyph.fail} `}</text>
        <text fg={tokens.text.default} wrapMode="none">{"no provider connected"}</text>
        <text fg={tokens.text.dim} wrapMode="none">{"   — :login opens the provider manager"}</text>
      </box>
      <box flexDirection="row">
        <text fg={tokens.state.warn} flexShrink={0}>{`  ${glyph.pending} `}</text>
        <text fg={tokens.text.default} wrapMode="none">{`model ${roles().general}`}</text>
        <text fg={tokens.text.dim} wrapMode="none">{"   — :model to change it"}</text>
      </box>
      <box flexDirection="row">
        <text fg={BRAND.chartreuse} flexShrink={0}>{`  ${glyph.caret}`}</text>
        <text fg={tokens.text.dim} wrapMode="none">
          {"then describe what to build — refine → :lock → :forge"}
        </text>
      </box>
    </box>
  )
}

export const Workspace = (props: { ctx: SmithTuiContext }) => {
  const view = props.ctx.store.workspace
  return (
    <Show when={!view().unconfigured} fallback={<Onboarding ctx={props.ctx} />}>
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="row" marginTop={1}>
          <Logo compact />
        </box>
        <ProviderStrip ctx={props.ctx} />
        <box flexDirection="row" flexGrow={1}>
          <box flexDirection="column" flexGrow={1}>
            <SectionHead accent={BRAND.verdigris} label="specs" />
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

            <SectionHead accent={BRAND.ember} label="forge runs" />
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

            <SectionHead accent={BRAND.chartreuse} label="sessions (:resume)" />
            <Show
              when={view().sessions.length > 0}
              fallback={<text fg={tokens.state.pending}>{"  (none yet)"}</text>}
            >
              <For each={view().sessions}>
                {(session) => (
                  <box flexDirection="row">
                    <text fg={tokens.text.default} wrapMode="none" flexShrink={1}>
                      {`  ${glyph.bullet} ${session.label}`}
                    </text>
                    <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>
                      {session.ageMinutes < 60
                        ? `  ${session.ageMinutes}m ago`
                        : `  ${Math.round(session.ageMinutes / 60)}h ago`}
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </box>

          <box flexDirection="column" width={56} flexShrink={0} marginLeft={2}>
            <SectionHead accent={tokens.accent.input} label="lessons (fed to the next refine + forge)" />
            <Show
              when={view().lessons.length > 0}
              fallback={
                <text fg={tokens.state.pending}>
                  {"  none yet — they grow from gate rejections"}
                </text>
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
      </box>
    </Show>
  )
}
