import { createMemo, For, Match, Show, Switch } from "solid-js"
import type { OnboardingState } from "../../presentation/onboardingFlow.js"
import type { LoginFlow } from "../../presentation/loginFlow.js"
import type { SelectState, SelectOption } from "../../presentation/selectBox.js"
import { glyph, tokens } from "../../state/theme.js"
import { Cursor, Logo, Modal, MODAL_RULE, MODAL_WIDTH, Rule } from "../ui/index.js"

const MAX_ROWS = 10
const LABEL_BUDGET = MODAL_RULE - 2

type StepView =
  | { readonly tag: "select"; readonly sel: SelectState<unknown> }
  | {
      readonly tag: "prompt"
      readonly title: string
      readonly prompt: string
      readonly value: string
      readonly mask: boolean
    }

const stepView = (flow: LoginFlow): StepView => {
  switch (flow.step) {
    case "authMethod":
    case "provider":
      return { tag: "select", sel: flow.sel }
    case "apiKey":
    case "localUrl":
      return {
        tag: "prompt",
        title: flow.prompt.title,
        prompt: flow.prompt.prompt,
        value: flow.prompt.value,
        mask: flow.prompt.mask,
      }
    case "oauth":
      return {
        tag: "prompt",
        title: flow.manual.title,
        prompt: `${flow.status}\n\n${flow.manual.prompt}`,
        value: flow.manual.value,
        mask: flow.manual.mask,
      }
  }
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

const OnboardingSelectContent = (props: { state: SelectState<unknown> }) => {
  const s = () => props.state
  const n = () => s().matches.length
  const listRows = () => Math.min(MAX_ROWS, Math.max(1, n()))

  const win = createMemo(() => {
    const rows = listRows()
    let start = s().selected - Math.floor(rows / 2)
    start = Math.max(0, Math.min(start, Math.max(0, n() - rows)))
    return { start, rows, moreAbove: start > 0, moreBelow: start + rows < n() }
  })

  const visible = createMemo(() => {
    const { start, rows } = win()
    return s()
      .matches.slice(start, start + rows)
      .map((opt, i) => ({ opt: opt as SelectOption<unknown>, idx: start + i, pos: i }))
  })

  const marker = (idx: number, pos: number): string => {
    const w = win()
    if (idx === s().selected) return glyph.pointer
    if (pos === 0 && w.moreAbove) return glyph.more.above
    if (pos === w.rows - 1 && w.moreBelow) return glyph.more.below
    return " "
  }

  return (
    <box flexDirection="column">
      <text fg={tokens.text.default} marginBottom={1}>
        {s().title}
      </text>
      <box flexDirection="row">
        <text fg={tokens.text.muted} wrapMode="none">{`/ ${s().filter}`}</text>
        <Cursor />
      </box>
      <box height={1} />

      <Show
        when={n() > 0}
        fallback={<text fg={tokens.text.muted}>(no matches)</text>}
      >
        <For each={visible()}>
          {(row) => {
            const sel = () => row.idx === s().selected
            return (
              <box flexDirection="row" {...(sel() ? { backgroundColor: tokens.cursorLine } : {})}>
                <text fg={sel() ? tokens.accent.conversation : tokens.text.muted}>
                  {`${marker(row.idx, row.pos)} `}
                </text>
                <text fg={sel() ? tokens.text.default : tokens.text.muted} wrapMode="none" flexGrow={1}>
                  {truncate(row.opt.label, row.opt.active === true ? LABEL_BUDGET - 9 : LABEL_BUDGET)}
                </text>
                <Show when={row.opt.active === true}>
                  <text fg={tokens.text.muted}>{` ${glyph.activeTag} active`}</text>
                </Show>
              </box>
            )
          }}
        </For>
      </Show>

      <box height={1} />
      <box flexDirection="row">
        <text fg={tokens.text.muted} flexGrow={1}>
          [↑/↓ navigate · type to filter · Enter select · Esc back]
        </text>
        <text fg={tokens.text.muted}>{n() === 0 ? "0/0" : `${s().selected + 1}/${n()}`}</text>
      </box>
    </box>
  )
}

const OnboardingPromptContent = (props: {
  title: string
  prompt: string
  value: string
  mask: boolean
}) => {
  const shown = () => (props.mask ? "•".repeat(props.value.length) : props.value)
  const isLinkPrompt = () => props.prompt.includes("http://") || props.prompt.includes("https://")

  return (
    <box flexDirection="column">
      <text fg={tokens.text.default} marginBottom={1}>
        {props.title}
      </text>
      <Show
        when={isLinkPrompt()}
        fallback={
          <text fg={tokens.text.muted} wrapMode="word">
            {props.prompt}
          </text>
        }
      >
        <text fg={tokens.text.muted} wrapMode="word">
          Open this link in the browser:
        </text>
        <Rule width={MODAL_RULE} />
        <text fg={tokens.accent.conversation} wrapMode="word">
          {props.prompt.split("\n\n")[1] || props.prompt}
        </text>
        <Rule width={MODAL_RULE} />
      </Show>
      <box height={1} />
      <box flexDirection="row">
        <text fg={tokens.text.default} wrapMode="none">
          {shown()}
        </text>
        <Cursor />
      </box>
      <box height={1} />
      <text fg={tokens.text.muted}>[Enter to submit, Escape to go back]</text>
    </box>
  )
}

const OnboardingLoginView = (props: { flow: LoginFlow }) => {
  const view = createMemo(() => stepView(props.flow))
  return (
    <Switch>
      <Match when={view().tag === "select"}>
        <OnboardingSelectContent state={(view() as Extract<StepView, { tag: "select" }>).sel} />
      </Match>
      <Match when={view().tag === "prompt"}>
        {(() => {
          const v = view() as Extract<StepView, { tag: "prompt" }>
          return <OnboardingPromptContent title={v.title} prompt={v.prompt} value={v.value} mask={v.mask} />
        })()}
      </Match>
    </Switch>
  )
}
export const OnboardingView = (props: { state: OnboardingState }) => {
  const s = () => props.state
  const loginFlowState = () => (s() as Extract<OnboardingState, { step: "login" }>).flow

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      // Opaque base surface — the onboarding is full-screen and the live rail
      // keeps writing underneath, so a transparent fill lets that text bleed
      // through and collide. We mask with `status.bg` (the app's own darkest
      // base, shared with the status bar) rather than the lighter modal
      // `overlay.bg`, so opening onboarding doesn't visibly *recolour* the
      // screen — it reads as the same near-black surface the chrome already uses.
      backgroundColor={tokens.status.bg}
      flexDirection="column"
      paddingLeft={4}
      paddingRight={4}
      paddingTop={2}
    >
      <Logo variant="master" />
      <box height={1} />

      <box width={MODAL_RULE} flexDirection="column">
        <Show when={s().step === "login"}>
          {/* Welcome line only on the FIRST screen (authMethod), agy-style. Its
              wording reflects whether a credential already exists — a fresh run
              says "not signed in"; a re-run (`:onboarding`) says "set up". */}
          <Show when={loginFlowState().step === "authMethod"}>
            <text fg={tokens.text.default}>
              {s().statuses.some((p) => p.configured !== undefined)
                ? "Welcome back to the Efferent CLI. Reconfigure your setup below."
                : "Welcome to the Efferent CLI. You are currently not signed in."}
            </text>
            <text fg={tokens.text.muted} wrapMode="word" marginBottom={1}>
              {"Step 1 of 4 — we'll set up a provider, your main + fast models, and a theme."}
            </text>
            <box height={1} />
          </Show>
          <OnboardingLoginView flow={loginFlowState()} />
        </Show>

        <Show when={s().step === "mainModel"}>
          <OnboardingSelectContent state={(s() as Extract<OnboardingState, { step: "mainModel" }>).sel} />
        </Show>

        <Show when={s().step === "fastModel"}>
          <OnboardingSelectContent state={(s() as Extract<OnboardingState, { step: "fastModel" }>).sel} />
        </Show>

        <Show when={s().step === "theme"}>
          <OnboardingSelectContent state={(s() as Extract<OnboardingState, { step: "theme" }>).sel} />
        </Show>

        <Show when={s().step === "complete"}>
          <box flexDirection="column" marginTop={1} marginBottom={1}>
            <text fg={tokens.state.ok} wrapMode="none" marginBottom={1}>
              {glyph.ok} Onboarding Complete!
            </text>
            <text fg={tokens.text.default} marginBottom={1}>
              You are ready to go!
            </text>
            <text fg={tokens.text.muted} wrapMode="word" marginBottom={2}>
              Your credentials, model preferences, and theme have been successfully configured.
              You can access these settings anytime via the :settings command.
            </text>
            <text fg={tokens.text.muted}>
              [Enter to start using Efferent · Esc to go back]
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}
