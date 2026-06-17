import { createMemo, Match, Show, Switch } from "solid-js"
import type { OnboardingState } from "../../presentation/onboardingFlow.js"
import type { LoginFlow } from "../../presentation/loginFlow.js"
import type { SelectState } from "../../presentation/selectBox.js"
import { glyph, tokens } from "../../state/theme.js"
import { KeyHints, Logo, MODAL_RULE, PromptBody, Rule, SelectBody, type KeyHint } from "../ui/index.js"

/** Footer hints, agy-style (accent key chips + dim labels via `KeyHints`),
 *  shared by every onboarding step. `canBack` is false only on the very first
 *  screen (the auth-method picker) where Esc exits instead of going back. */
const selectFooter = (canBack: boolean): ReadonlyArray<KeyHint> => [
  { key: "↑/↓", label: "navigate" },
  { key: "type", label: "filter" },
  { key: "↵", label: "select" },
  { key: "esc", label: canBack ? "back" : "quit" },
]
const promptFooter: ReadonlyArray<KeyHint> = [
  { key: "↵", label: "submit" },
  { key: "esc", label: "back" },
]

type StepView =
  | { readonly tag: "select"; readonly sel: SelectState<unknown>; readonly canBack: boolean }
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
      return { tag: "select", sel: flow.sel, canBack: false }
    case "provider":
      return { tag: "select", sel: flow.sel, canBack: true }
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

/** A step title line + its shared select body — used for every picker step. */
const SelectStep = (props: { title: string; state: SelectState<unknown>; canBack: boolean }) => (
  <box flexDirection="column">
    <text fg={tokens.text.default} marginBottom={1}>
      {props.title}
    </text>
    <SelectBody state={props.state} labelBudget={MODAL_RULE - 2} footer={selectFooter(props.canBack)} />
  </box>
)

/** A prompt step: title + (rich link block for OAuth, else plain prompt via the
 *  shared PromptBody). The OAuth redirect URL gets its own ruled callout. */
const PromptStep = (props: { title: string; prompt: string; value: string; mask: boolean }) => {
  const isLink = () => props.prompt.includes("http://") || props.prompt.includes("https://")
  return (
    <box flexDirection="column">
      <text fg={tokens.text.default} marginBottom={1}>
        {props.title}
      </text>
      <Show
        when={isLink()}
        fallback={
          <PromptBody prompt={props.prompt} value={props.value} mask={props.mask} footer={promptFooter} />
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
        <PromptBody value={props.value} mask={props.mask} footer={promptFooter} />
      </Show>
    </box>
  )
}

const OnboardingLoginView = (props: { flow: LoginFlow }) => {
  const view = createMemo(() => stepView(props.flow))
  return (
    <Switch>
      <Match when={view().tag === "select"}>
        {(() => {
          const v = view() as Extract<StepView, { tag: "select" }>
          return <SelectStep title={v.sel.title} state={v.sel} canBack={v.canBack} />
        })()}
      </Match>
      <Match when={view().tag === "prompt"}>
        {(() => {
          const v = view() as Extract<StepView, { tag: "prompt" }>
          return <PromptStep title={v.title} prompt={v.prompt} value={v.value} mask={v.mask} />
        })()}
      </Match>
    </Switch>
  )
}

export const OnboardingView = (props: { state: OnboardingState; note?: string | undefined }) => {
  const s = () => props.state
  const loginFlowState = () => (s() as Extract<OnboardingState, { step: "login" }>).flow

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      // Transparent — App renders ONLY the onboarding while it's open (no panes
      // behind it), so this shows the terminal background like the rest of the
      // app, with nothing to bleed through. No recoloured surface.
      backgroundColor={tokens.bgNone}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      <Logo variant="master" />

      <box width={MODAL_RULE} flexDirection="column">
        <Show when={s().step === "login"}>
          {/* Welcome line only on the FIRST screen (authMethod), agy-style. Its
              wording reflects whether a credential already exists. */}
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
          {(() => {
            const sel = (s() as Extract<OnboardingState, { step: "mainModel" }>).sel
            return <SelectStep title={sel.title} state={sel} canBack={true} />
          })()}
        </Show>

        <Show when={s().step === "fastModel"}>
          {(() => {
            const sel = (s() as Extract<OnboardingState, { step: "fastModel" }>).sel
            return <SelectStep title={sel.title} state={sel} canBack={true} />
          })()}
        </Show>

        <Show when={s().step === "theme"}>
          {(() => {
            const sel = (s() as Extract<OnboardingState, { step: "theme" }>).sel
            return <SelectStep title={sel.title} state={sel} canBack={true} />
          })()}
        </Show>

        <Show when={s().step === "complete"}>
          <box flexDirection="column" marginTop={1} marginBottom={1}>
            <text fg={tokens.state.ok} wrapMode="none" marginBottom={1}>
              {`${glyph.ok} Onboarding complete!`}
            </text>
            <text fg={tokens.text.default} marginBottom={1}>
              You are ready to go.
            </text>
            <text fg={tokens.text.muted} wrapMode="word" marginBottom={2}>
              Your credentials, model preferences, and theme are saved. Change them anytime
              via :settings, :model, :login, or :theme.
            </text>
            <KeyHints
              hints={[
                { key: "↵", label: "start using Efferent" },
                { key: "esc", label: "back" },
              ]}
            />
          </box>
        </Show>
      </box>

      {/* Transient hint line (e.g. the Ctrl-C-again-to-quit arming toast) —
          rendered here because onboarding hides the status bar that normally
          shows it. Dim + subtle, agy-style. */}
      <Show when={props.note !== undefined}>
        <box flexGrow={1} />
        <text fg={tokens.text.dim}>{props.note}</text>
      </Show>
    </box>
  )
}
