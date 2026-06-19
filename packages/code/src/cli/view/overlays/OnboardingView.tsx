import { createMemo, Match, Show, Switch } from "solid-js"
import type { OnboardingState } from "../../presentation/onboardingFlow.js"
import type { LoginFlow } from "../../presentation/loginFlow.js"
import type { SelectState } from "../../presentation/selectBox.js"
import { glyph, tokens } from "../../state/theme.js"
import {
  KeyHints,
  Logo,
  MODAL_RULE,
  PromptBody,
  Rule,
  SelectBody,
  ThemePreview,
  type KeyHint,
} from "../ui/index.js"

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
    case "home":
      return { tag: "select", sel: flow.sel, canBack: true }
    case "method":
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

// Theme step: the list on the left, a live `ThemePreview` on the right (agy
// pattern). Moving the highlight live-swaps the active theme (`keys/overlay.ts`),
// so the preview — painting the reactive tokens — recolours along with the list.
// The theme step gets its own slightly-wider container (it's the one step where
// seeing the preview big matters), so a roomy preview + generous gap don't squeeze
// the list down to truncating the names.
const THEME_TOTAL_W = 76
const THEME_GAP = 4
const THEME_PREVIEW_W = 46
const THEME_LIST_W = THEME_TOTAL_W - THEME_GAP - THEME_PREVIEW_W // = 26
// The full nav footer won't fit beside the preview in the narrow list column, so
// the theme step uses a compact two-hint footer (↑/↓ + filter stay discoverable).
const themeFooter: ReadonlyArray<KeyHint> = [
  { key: "↵", label: "pick" },
  { key: "esc", label: "back" },
]

/** The theme picker step — title above, list + live preview side by side.
 *  Moving the highlight live-swaps the theme, so the preview recolours with it. */
const ThemeStep = (props: { state: SelectState<string> }) => (
  <box flexDirection="column">
    <text fg={tokens.text.default} marginBottom={1}>
      {props.state.title}
    </text>
    <box flexDirection="row">
      <box width={THEME_LIST_W}>
        <SelectBody state={props.state} labelBudget={THEME_LIST_W - 4} footer={themeFooter} />
      </box>
      <box width={THEME_GAP} />
      <ThemePreview width={THEME_PREVIEW_W} />
    </box>
  </box>
)

// The database step (step 6) is a MANAGER: the list of configured connections
// (manage mode) with add/done rows. Picking add opens `connect` — a SQLite file
// path (`adding: "local"`) or a postgres connection string (`adding: "remote"`).
// The hint adapts to `adding`. Rendered with PromptBody directly (not PromptStep),
// so the neon.tech mention doesn't trip PromptStep's link callout.
const dbConnectFooter: ReadonlyArray<KeyHint> = [
  { key: "↵", label: "save" },
  { key: "esc", label: "back" },
]

// The manager footer advertises the row actions (↵/e edit a connection — saving
// reconnects + makes it default — and d removes it) — the generic select footer
// doesn't.
const dbManagerFooter: ReadonlyArray<KeyHint> = [
  { key: "↑/↓", label: "navigate" },
  { key: "type", label: "search" },
  { key: "↵", label: "edit" },
  { key: "^D", label: "remove" },
  { key: "esc", label: "back" },
]

const DatabaseStep = (props: { state: Extract<OnboardingState, { step: "database" }> }) => (
  <Show
    when={props.state.connect}
    fallback={
      <box flexDirection="column">
        <text fg={tokens.text.default} marginBottom={1}>
          {props.state.sel.title}
        </text>
        <Show when={props.state.confirmRemove !== undefined}>
          <text fg={tokens.state.error} wrapMode="none" marginBottom={1}>
            {`Remove ${props.state.confirmRemove}? ↵ confirm · esc cancel`}
          </text>
        </Show>
        <SelectBody state={props.state.sel} labelBudget={MODAL_RULE - 2} footer={dbManagerFooter} />
      </box>
    }
  >
    {(connect) => (
      <box flexDirection="column">
        <text fg={tokens.text.default} marginBottom={1}>
          {connect().title}
        </text>
        <text fg={tokens.text.dim} wrapMode="word" marginBottom={1}>
          {props.state.adding === "remote"
            ? "No database yet? Create a free serverless one at neon.tech and paste its connection string here."
            : "Where conversation history is stored. Press Enter to accept the default, or edit the path."}
        </text>
        <PromptBody prompt={connect().prompt} value={connect().value} mask={connect().mask} footer={dbConnectFooter} />
      </box>
    )}
  </Show>
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

// The login flow's titles come from `loginFlow.ts` (shared with the runtime
// `:login` overlay, which carries no counter), so the "Step 2 of 5 · …" prefix is
// applied here — onboarding-only — to match the one-line header every other step
// already shows from `onboardingFlow.ts`.
const OnboardingLoginView = (props: { flow: LoginFlow; stepLabel: string }) => {
  const view = createMemo(() => stepView(props.flow))
  return (
    <Switch>
      <Match when={view().tag === "select"}>
        {(() => {
          const v = view() as Extract<StepView, { tag: "select" }>
          return <SelectStep title={`${props.stepLabel} · ${v.sel.title}`} state={v.sel} canBack={v.canBack} />
        })()}
      </Match>
      <Match when={view().tag === "prompt"}>
        {(() => {
          const v = view() as Extract<StepView, { tag: "prompt" }>
          return (
            <PromptStep
              title={`${props.stepLabel} · ${v.title}`}
              prompt={v.prompt}
              value={v.value}
              mask={v.mask}
            />
          )
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
      <Logo variant="code" />

      {/* One consistent blank line between the logo and the step body on EVERY
          step (marginTop), so the gap never changes as you move through. The
          theme step widens to fit its list + larger preview; all others keep the
          standard modal width so titles/prose stay aligned. */}
      <box
        width={s().step === "theme" ? THEME_TOTAL_W : MODAL_RULE}
        flexDirection="column"
        marginTop={1}
      >
        {/* Step 1 — the scope picker is the FIRST screen, so it carries the
            welcome line (agy-style). */}
        <Show when={s().step === "scope"}>
          {(() => {
            const sel = (s() as Extract<OnboardingState, { step: "scope" }>).sel
            return (
              <box flexDirection="column">
                <text fg={tokens.text.default}>
                  {s().statuses.some((p) => p.configured !== undefined)
                    ? "Welcome back to the Efferent CLI."
                    : "Welcome to the Efferent CLI. You are currently not signed in."}
                </text>
                <text fg={tokens.text.muted} wrapMode="word" marginBottom={1}>
                  {"We'll set up a provider, your main + fast models, a theme, and where conversations are stored — once."}
                </text>
                <SelectStep title={sel.title} state={sel} canBack={false} />
              </box>
            )
          })()}
        </Show>

        <Show when={s().step === "login"}>
          <OnboardingLoginView flow={loginFlowState()} stepLabel="Step 2 of 6" />
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
            return <ThemeStep state={sel} />
          })()}
        </Show>

        <Show when={s().step === "database"}>
          {(() => {
            const st = s() as Extract<OnboardingState, { step: "database" }>
            return <DatabaseStep state={st} />
          })()}
        </Show>

        <Show when={s().step === "complete"}>
          <box flexDirection="column" marginBottom={1}>
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

      {/* Transient hint line (login confirmations, the Ctrl-C-again-to-quit
          arming toast, db "connecting…") — rendered here because onboarding hides
          the status bar that normally shows it. Sits just below the step body
          (one blank line) instead of pinned to the bottom of the screen, so it
          reads as feedback for the section above it. Dim + subtle, agy-style. */}
      <Show when={props.note !== undefined}>
        <text fg={tokens.text.dim} marginTop={1}>{props.note}</text>
      </Show>
    </box>
  )
}
