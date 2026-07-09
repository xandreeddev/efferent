import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { For, Show } from "solid-js"
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid"
import { Option } from "effect"
import { runTuiCommand } from "../commands.js"
import { dispatch, dispatchPaste } from "../keys.js"
import { glyph, tokens } from "../theme.js"
import type { SmithTuiContext } from "../state/store.js"
import { attemptRowView } from "../presentation/floor.js"
import type { GateCell } from "../presentation/floor.js"
import { contextGauge, contextTokens } from "../presentation/conversation.js"
import { flowView } from "../presentation/flow.js"
import type { FlowStep } from "../presentation/flow.js"
import { contextWindowOf } from "../presentation/modelCatalog.js"
import { OverlayView } from "./Overlay.js"
import { Workspace } from "./Workspace.js"
import { computePalette } from "../presentation/palette.js"

const TRANSCRIPT_ROWS = 20

const cellColor = (state: GateCell["state"]): string =>
  state === "pass"
    ? tokens.state.ok
    : state === "fail"
      ? tokens.state.error
      : state === "running"
        ? tokens.state.running
        : state === "skip"
          ? tokens.state.warn
          : tokens.state.pending

const cellGlyph = (state: GateCell["state"]): string =>
  state === "pass"
    ? glyph.pass
    : state === "fail"
      ? glyph.fail
      : state === "running"
        ? glyph.running
        : state === "skip"
          ? glyph.skip
          : glyph.pending

/** The header: brand · task · attempt/phase heartbeat (mode-aware). */
const Header = (props: { ctx: SmithTuiContext }) => {
  const { store } = props.ctx
  const floor = store.floor
  const spin = () => glyph.spinner[store.spinner() % glyph.spinner.length]
  const forging = () => floor().phase === "implementing" || floor().phase === "gating"
  // The spinner tick re-renders these every 120ms — a slow model call shows
  // a RUNNING clock and, past 30s of event silence, an explicit hint.
  const elapsed = () => {
    store.spinner()
    return store.busySince() > 0 ? Math.floor((Date.now() - store.busySince()) / 1000) : 0
  }
  const stalled = () => {
    store.spinner()
    return (
      (store.busy() || forging()) &&
      store.lastEventAt() > 0 &&
      Date.now() - store.lastEventAt() > 30_000
    )
  }
  const heartbeat = () => {
    if (store.mode() === "idle") {
      return "describe what to build — :forge <slug> · :model · :login · :quit"
    }
    if (store.mode() === "refine") {
      return store.busy()
        ? `${spin()} refining… ${elapsed()}s${stalled() ? " — the model is SLOW to respond; Esc cancels" : ""}`
        : store.refine().locked
          ? "spec locked — :forge to build"
          : ":lock when the spec is right"
    }
    return forging()
      ? `${spin()} ${floor().phase} · attempt ${floor().attempts.length}/${floor().maxAttempts}${stalled() ? " — SLOW; Esc interrupts" : ""}`
      : floor().phase === "boot"
        ? "starting…"
        : floor().phase
  }
  const busyColor = () => (store.busy() || forging() ? tokens.state.running : tokens.text.dim)
  const title = () =>
    store.mode() === "idle"
      ? props.ctx.runConfig.cwd
      : store.mode() === "refine"
        ? Option.getOrElse(
            Option.map(store.refine().draft, (d) => String(d.slug)),
            () => props.ctx.runConfig.task,
          )
        : floor().task
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={tokens.accent.brand} flexShrink={0}>{glyph.brand}</text>
      <text fg={tokens.text.bright} flexShrink={0}>
        {store.mode() === "idle" ? "smith · " : store.mode() === "refine" ? "smith spec " : "smith "}
      </text>
      <text fg={tokens.text.dim} flexGrow={1} wrapMode="none">
        {title()}
      </text>
      <text fg={busyColor()} flexShrink={0}>{` ${heartbeat()}`}</text>
    </box>
  )
}

/** The CONVERSATION pane — the session's full story, full width: what you
 *  said, what the model THOUGHT (reasoning is first-class, dim, never
 *  hidden), what it said (tagged with the model that said it), and every
 *  tool call inline with live status. Both modes render through it. */
const ConversationPane = (props: { ctx: SmithTuiContext; label: string }) => {
  const { store } = props.ctx
  const conversation = store.conversation
  const cwd = props.ctx.runConfig.cwd
  const relArg = (arg: string): string =>
    arg === cwd ? "." : arg.startsWith(`${cwd}/`) ? arg.slice(cwd.length + 1) : arg
  // A property-mutated holder (the composerClear pattern) — `let` is banned.
  const scroll = { current: undefined as ScrollBoxRenderable | undefined }
  useKeyboard((key) => {
    if (key.name === "pageup") scroll.current?.scrollBy(-8)
    if (key.name === "pagedown") scroll.current?.scrollBy(8)
  })
  const spin = () => glyph.spinner[store.spinner() % glyph.spinner.length]
  const elapsed = () => {
    store.spinner()
    return store.busySince() > 0 ? Math.floor((Date.now() - store.busySince()) / 1000) : 0
  }
  return (
    <box flexDirection="column" flexGrow={1} marginTop={1}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={tokens.accent.input} flexShrink={0}>{`${glyph.brand} `}</text>
        <text fg={tokens.text.dim} wrapMode="none">{props.label}</text>
      </box>
      {/* The history is a SCROLLBOX: sticky-bottom follows the live tail,
          the wheel / PgUp / PgDn reach anything above (the clipped-top body
          made history unreachable — live complaint), and manual scroll
          re-engages when you return to the bottom. */}
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          scroll.current = r
        }}
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        scrollY={true}
        scrollX={false}
        contentOptions={{ flexDirection: "column" }}
      >
      <Show
        when={conversation().blocks.length > 0}
        fallback={
          <text fg={tokens.state.pending}>
            {"  describe what to build — the refiner drafts a spec you approve"}
          </text>
        }
      >
        <For each={conversation().blocks}>
          {(block) => {
            // Every block is flexShrink 0 on the COLUMN axis: yoga would
            // otherwise COMPRESS block heights to fit and the text would
            // overdraw its neighbors (live-caught fused rows) — excess
            // must clip at the top, never squeeze.
            if (block.kind === "user") {
              return (
                <text fg={tokens.accent.input} wrapMode="word" marginTop={1} flexShrink={0}>
                  {`${glyph.caret}${block.text}`}
                </text>
              )
            }
            // TURN SPACING (the agy rhythm): one blank line opens each turn
            // (the ▸ header or a leading assistant), everything inside a
            // turn — thought, text, tools — stays flush.
            if (block.kind === "reasoning") {
              return (
                <box flexDirection="column" flexShrink={0} marginTop={1}>
                  <text fg={tokens.text.dim} wrapMode="none">{`  ▸ ${block.tag}`}</text>
                  <box flexDirection="row">
                    <text flexShrink={0}>{"    "}</text>
                    <text fg={tokens.text.dim} wrapMode="word" flexShrink={1}>
                      {block.text}
                    </text>
                  </box>
                </box>
              )
            }
            if (block.kind === "assistant") {
              return (
                <box flexDirection="column" flexShrink={0} marginTop={block.leading ? 1 : 0}>
                  <Show when={block.text.length > 0}>
                    <text fg={tokens.text.bright} wrapMode="word">{`  ${block.text}`}</text>
                  </Show>
                  <Show when={block.leading}>
                    <text fg={tokens.text.dim} wrapMode="none">{`  └ ${block.tag}`}</text>
                  </Show>
                </box>
              )
            }
            if (block.kind === "error") {
              return (
                <box flexDirection="row" flexShrink={0} marginTop={1}>
                  <text fg={tokens.state.error} flexShrink={0}>{`  ${glyph.fail} `}</text>
                  <text fg={tokens.state.error} wrapMode="word" flexShrink={1}>
                    {block.text}
                  </text>
                </box>
              )
            }
            if (block.kind === "notice") {
              return (
                <box flexDirection="row" flexShrink={0} marginTop={1}>
                  <text fg={tokens.state.warn} flexShrink={0}>{"  ⚠ "}</text>
                  <text fg={tokens.state.warn} wrapMode="word" flexShrink={1}>
                    {block.text}
                  </text>
                </box>
              )
            }
            // The agy color language: bullet AND tool NAME carry the state
            // color (green done / blue running / red failed) so the action
            // pops; only the argument stays muted. Paths render RELATIVE to
            // the workspace — absolute prefixes are noise.
            const statusColor =
              block.status === "ok"
                ? tokens.state.ok
                : block.status === "fail"
                  ? tokens.state.error
                  : tokens.state.running
            return (
              <box flexDirection="row" flexShrink={0}>
                <text fg={statusColor} flexShrink={0}>{"  ● "}</text>
                <text fg={statusColor} flexShrink={0}>{block.name}</text>
                <text fg={tokens.text.muted} wrapMode="none" flexShrink={1}>
                  {`(${relArg(block.arg)})`}
                </text>
              </box>
            )
          }}
        </For>
      </Show>
      </scrollbox>
      {/* The in-pane heartbeat: a thinking model was ONLY visible in the
          header's tiny clock — the pane looked dead for minutes on a long
          turn ("the session hung"). */}
      <Show when={store.busy()}>
        <box flexDirection="row" flexShrink={0}>
          <text fg={tokens.state.running} flexShrink={0}>
            {`  ${spin()} thinking… ${elapsed()}s`}
          </text>
          <text fg={tokens.text.dim} wrapMode="none">
            {"  — Esc interrupts · wheel/PgUp scrolls the story"}
          </text>
        </box>
      </Show>
    </box>
  )
}

/** The live SpecDoc panel — goal, criteria, checks, status badge. */
const SpecPanel = (props: { ctx: SmithTuiContext }) => {
  const refine = props.ctx.store.refine
  const doc = () => Option.getOrUndefined(refine().draft)
  const badgeColor = () => (refine().locked ? tokens.state.ok : tokens.state.warn)
  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="row">
        <text fg={tokens.text.dim} flexGrow={1}>spec</text>
        <Show when={doc() !== undefined}>
          <text fg={badgeColor()} flexShrink={0}>
            {refine().locked ? "locked" : "draft"}
          </text>
        </Show>
      </box>
      <Show
        when={doc() !== undefined}
        fallback={<text fg={tokens.state.pending}>  (no draft yet)</text>}
      >
        <text fg={tokens.text.bright} wrapMode="word">{`  ${doc()?.goal ?? ""}`}</text>
        <Show when={(doc()?.acceptance.length ?? 0) > 0}>
          <text fg={tokens.text.dim} marginTop={1}>  acceptance</text>
          <For each={doc()?.acceptance ?? []}>
            {(item) => <text fg={tokens.text.default} wrapMode="word">{`    - ${item}`}</text>}
          </For>
        </Show>
        <Show when={(doc()?.checks.length ?? 0) > 0}>
          <text fg={tokens.text.dim} marginTop={1}>  checks (run as gates)</text>
          <For each={doc()?.checks ?? []}>
            {(check) => (
              <text fg={tokens.state.ok} wrapMode="none">{`    ✓ ${check.name}: ${check.command}`}</text>
            )}
          </For>
        </Show>
        <Show when={(doc()?.constraints.length ?? 0) > 0}>
          <text fg={tokens.text.dim} marginTop={1}>  constraints</text>
          <For each={doc()?.constraints ?? []}>
            {(item) => <text fg={tokens.text.default} wrapMode="word">{`    - ${item}`}</text>}
          </For>
        </Show>
      </Show>
      <Show when={Option.isSome(refine().error)}>
        <text fg={tokens.state.error} wrapMode="word" marginTop={1}>
          {`  ${Option.getOrElse(refine().error, () => "")}`}
        </text>
      </Show>
    </box>
  )
}

/** The attempt × gate matrix — the factory floor's centrepiece. Rows render
 *  through the BOUNDED view model: few gates = named cells (clipped), many
 *  gates = a tally + the one gate that matters now — a row can never
 *  overflow the panel into the feed. */
/** The flow stepper — WHERE the session is in the pipeline, always at the
 *  top of the side panel: what's done, what's live, what only the human can
 *  do next (the "hard to understand which phase we're in" complaint). */
const FlowPanel = (props: { ctx: SmithTuiContext }) => {
  const { store } = props.ctx
  const steps = () => flowView(store.mode(), store.refine(), store.floor())
  const stepGlyph = (state: FlowStep["state"]): string =>
    state === "done" ? glyph.pass : state === "current" ? "●" : "○"
  const stepColor = (state: FlowStep["state"]): string =>
    state === "done"
      ? tokens.state.ok
      : state === "current"
        ? tokens.state.running
        : tokens.state.pending
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <text fg={tokens.text.dim}>the flow</text>
      <For each={steps()}>
        {(step) => (
          <box flexDirection="row">
            <text fg={stepColor(step.state)} flexShrink={0}>{`  ${stepGlyph(step.state)} `}</text>
            <text
              fg={step.state === "current" ? tokens.text.bright : tokens.text.default}
              flexShrink={0}
            >
              {step.label.padEnd(7)}
            </text>
            <text fg={tokens.text.dim} wrapMode="none" flexShrink={1}>
              {step.detail}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

/** The side column: the flow stepper pinned on top, the artifact (spec or
 *  attempts) SCROLLABLE below — 40% of the terminal, never a fixed 52. */
const SidePanel = (props: { ctx: SmithTuiContext; artifact: "spec" | "attempts" }) => {
  const dimensions = useTerminalDimensions()
  const width = () => Math.max(44, Math.floor(dimensions().width * 0.4))
  return (
    <box flexDirection="column" width={width()} flexShrink={0} marginLeft={2}>
      <FlowPanel ctx={props.ctx} />
      <scrollbox
        flexGrow={1}
        scrollY={true}
        scrollX={false}
        contentOptions={{ flexDirection: "column" }}
      >
        <Show when={props.artifact === "spec"} fallback={<AttemptPanel ctx={props.ctx} />}>
          <SpecPanel ctx={props.ctx} />
        </Show>
      </scrollbox>
    </box>
  )
}

const AttemptPanel = (props: { ctx: SmithTuiContext }) => {
  const floor = props.ctx.store.floor
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={tokens.text.dim}>attempts</text>
      <Show
        when={floor().attempts.length > 0}
        fallback={<text fg={tokens.state.pending}>  (waiting for the first attempt)</text>}
      >
        <For each={floor().attempts.map(attemptRowView)}>
          {(row) => (
            <box flexDirection="row">
              <text fg={tokens.text.dim} flexShrink={0}>{`  #${row.attempt} `}</text>
              <Show
                when={row.mode === "cells"}
                fallback={
                  <>
                    <text fg={tokens.state.ok} flexShrink={0} wrapMode="none">
                      {`${glyph.pass}${row.counts.pass} `}
                    </text>
                    <text
                      fg={row.counts.fail > 0 ? tokens.state.error : tokens.text.dim}
                      flexShrink={0}
                      wrapMode="none"
                    >
                      {`${glyph.fail}${row.counts.fail} `}
                    </text>
                    <text fg={tokens.state.pending} flexShrink={0} wrapMode="none">
                      {`${glyph.pending}${row.counts.pending + row.counts.running + row.counts.skip} `}
                    </text>
                    <Show when={Option.isSome(row.active)}>
                      <text
                        fg={cellColor(Option.getOrThrow(row.active).state)}
                        flexShrink={1}
                        wrapMode="none"
                      >
                        {`${cellGlyph(Option.getOrThrow(row.active).state)} ${Option.getOrThrow(row.active).name}`}
                      </text>
                    </Show>
                  </>
                }
              >
                <For each={row.cells}>
                  {(cell) => (
                    <text fg={cellColor(cell.state)} flexShrink={1} wrapMode="none">
                      {`${cellGlyph(cell.state)} ${cell.name}${cell.state === "fail" ? `(${cell.findings})` : ""}  `}
                    </text>
                  )}
                </For>
              </Show>
              <Show when={row.files > 0}>
                <text fg={tokens.text.dim} flexShrink={0}>{`· ${row.files}f`}</text>
              </Show>
            </box>
          )}
        </For>
      </Show>
      <Show when={floor().findings.length > 0}>
        <text fg={tokens.text.dim} marginTop={1}>
          findings
        </text>
        <For each={floor().findings}>
          {(line) => (
            <text fg={tokens.state.error} wrapMode="none">{`  ${line}`}</text>
          )}
        </For>
      </Show>
    </box>
  )
}



/** Outcome + roles + notice — the two quiet status rows above the input. */
const StatusRows = (props: { ctx: SmithTuiContext }) => {
  const { store } = props.ctx
  const roles = store.roles
  const floor = store.floor
  // The LIVE context gauge: the latest turn's input tokens vs the active
  // model's window (code drives forge, general drives refine).
  const gauge = () => {
    const activeModel = store.mode() === "forge" ? roles().code : roles().general
    return Option.getOrElse(
      Option.map(
        contextGauge(contextTokens(store.conversation()), contextWindowOf(activeModel)),
        (text) => `   ${text}`,
      ),
      () => "",
    )
  }
  const rolesLine = () =>
    `● general ${roles().general}   code ${roles().code}   fast ${roles().fast}${gauge()}`
  const outcome = () => Option.getOrElse(floor().outcome, () => "")
  const outcomeColor = () => (floor().phase === "done" ? tokens.state.ok : tokens.state.error)
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <Show when={Option.isSome(floor().error)}>
        <box flexDirection="row">
          <text fg={tokens.state.error} flexShrink={0}>{`${glyph.fail} forge error: `}</text>
          <text fg={tokens.state.error} wrapMode="word" flexShrink={1}>
            {Option.getOrElse(floor().error, () => "")}
          </text>
        </box>
      </Show>
      <Show when={outcome().length > 0}>
        <box flexDirection="row">
          {/* The outcome never shrinks — the (long) artifact path clips instead. */}
          <text fg={outcomeColor()} wrapMode="none" flexShrink={0}>{outcome()}</text>
          <Show when={Option.isSome(floor().artifact)}>
            <text fg={tokens.text.dim} wrapMode="none" flexShrink={1}>
              {` · artifact ${Option.getOrElse(floor().artifact, () => "")}`}
            </text>
          </Show>
        </box>
      </Show>
      <Show when={Option.isSome(floor().conversationRef)}>
        <text fg={tokens.text.dim} wrapMode="none">
          {`session ${Option.getOrElse(floor().conversationRef, () => "")} — persisted in .efferent/smith.db`}
        </text>
      </Show>
      <box flexDirection="row">
        <text fg={tokens.text.dim} wrapMode="none" flexGrow={1}>
          {rolesLine()}
        </text>
        <text fg={tokens.state.warn} wrapMode="none" flexShrink={0}>
          {store.notice()}
        </text>
      </box>
    </box>
  )
}

/** The composer: refine mode sends plain text as refiner turns; `:`-prefixed
 *  input is always a command (`:quit · :lock · :forge · :model · :set`). */
const CommandLine = (props: { ctx: SmithTuiContext }) => {
  const ref: { current: TextareaRenderable | undefined } = { current: undefined }
  const submit = (): void => {
    const renderable = ref.current
    if (renderable === undefined) return
    const value = renderable.plainText.trim()
    if (value.length === 0) return
    renderable.setText("")
    if (value.startsWith(":")) {
      runTuiCommand(props.ctx, value)
      return
    }
    if (props.ctx.sendText !== undefined) {
      props.ctx.sendText(value)
      return
    }
    if (props.ctx.store.mode() === "refine" && props.ctx.sendRefine !== undefined) {
      props.ctx.sendRefine(value)
      return
    }
    props.ctx.store.setNotice("prefix commands with ':' (try :quit)")
  }
  const placeholder = () =>
    props.ctx.store.mode() === "idle"
      ? "describe what to build… — :model · :login · :quit"
      : props.ctx.store.mode() === "refine"
        ? "refine the spec… — :lock when right, :forge to build"
        : props.ctx.sendText !== undefined
          ? "type the next idea… — :new for the dashboard, :quit to leave"
          : ":quit · :model [code|fast] — Esc interrupts, Ctrl-C quits"
  return (
    <box flexDirection="row" flexShrink={0} marginTop={1}>
      <text fg={tokens.accent.input} flexShrink={0}>{glyph.caret}</text>
      <textarea
        ref={(renderable: TextareaRenderable) => {
          ref.current = renderable
          renderable.focus()
          props.ctx.store.registerComposerClear(() => renderable.setText(""))
          props.ctx.store.registerComposerRead(() => renderable.plainText)
        }}
        height={1}
        flexGrow={1}
        keyBindings={[{ name: "return", action: "submit" }]}
        placeholder={placeholder()}
        textColor={tokens.text.default}
        wrapMode="none"
        onSubmit={submit}
      />
    </box>
  )
}

/** The live `:` palette — command matches render under the composer as you
 *  type (polled off the spinner tick; the textarea has no input event). */
const Palette = (props: { ctx: SmithTuiContext }) => {
  const rows = () => {
    props.ctx.store.spinner()
    return computePalette(props.ctx.store.composerText().trim())
  }
  return (
    <Show when={rows().length > 0}>
      <box flexDirection="column" flexShrink={0}>
        <For each={rows()}>
          {(cmd) => (
            <box flexDirection="row">
              <text fg={tokens.accent.input} wrapMode="none" flexShrink={0}>
                {`  ${cmd.usage}`}
              </text>
              <text fg={tokens.text.dim} wrapMode="none" flexGrow={1}>{`  ${cmd.desc}`}</text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

/** The factory: refine mode (transcript + live SpecPanel) flows into forge
 *  mode (the floor). Borderless, token-driven — the cli's layout language. */
export const App = (props: { ctx: SmithTuiContext }) => {
  useKeyboard((key) => dispatch(props.ctx, key))
  usePaste((event) => {
    // Only overlays route pastes here — the composer textarea handles its own.
    if (props.ctx.store.overlay().kind === "none") return
    dispatchPaste(props.ctx, new TextDecoder().decode(event.bytes))
  })
  const mode = () => props.ctx.store.mode()
  const overlayOpen = () => props.ctx.store.overlay().kind !== "none"
  return (
    <box flexDirection="column" flexGrow={1} padding={1}>
      <Header ctx={props.ctx} />
      <Show when={mode() === "idle"}>
        <Workspace ctx={props.ctx} />
      </Show>
      <Show when={mode() === "refine"}>
        <box flexDirection="row" flexGrow={1}>
          <ConversationPane ctx={props.ctx} label="conversation — the refiner" />
          <SidePanel ctx={props.ctx} artifact="spec" />
        </box>
      </Show>
      <Show when={mode() === "forge"}>
        <box flexDirection="row" flexGrow={1}>
          <ConversationPane ctx={props.ctx} label="conversation — the implementor" />
          <SidePanel ctx={props.ctx} artifact="attempts" />
        </box>
      </Show>
      <StatusRows ctx={props.ctx} />
      {/* ONE surface owns the bottom: the composer, or the open overlay
          (unmounting the textarea kills the focus fight; the ref re-focuses
          on remount). */}
      <Show when={!overlayOpen()} fallback={<OverlayView ctx={props.ctx} />}>
        <CommandLine ctx={props.ctx} />
        <Palette ctx={props.ctx} />
      </Show>
    </box>
  )
}
