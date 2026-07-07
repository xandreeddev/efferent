import type { TextareaRenderable } from "@opentui/core"
import { For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Option } from "effect"
import { runTuiCommand } from "../commands.js"
import { dispatch } from "../keys.js"
import { glyph, tokens } from "../theme.js"
import type { SmithTuiContext } from "../state/store.js"
import type { GateCell } from "../presentation/floor.js"

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

const FEED_ROWS = 18

/** The header: brand · task · attempt/phase heartbeat (mode-aware). */
const Header = (props: { ctx: SmithTuiContext }) => {
  const { store } = props.ctx
  const floor = store.floor
  const spin = () => glyph.spinner[store.spinner() % glyph.spinner.length]
  const forging = () => floor().phase === "implementing" || floor().phase === "gating"
  const heartbeat = () => {
    if (store.mode() === "refine") {
      return store.busy()
        ? `${spin()} refining…`
        : store.refine().locked
          ? "spec locked — :forge to build"
          : ":lock when the spec is right"
    }
    return forging()
      ? `${spin()} ${floor().phase} · attempt ${floor().attempts.length}/${floor().maxAttempts}`
      : floor().phase === "boot"
        ? "starting…"
        : floor().phase
  }
  const busyColor = () => (store.busy() || forging() ? tokens.state.running : tokens.text.dim)
  const title = () =>
    store.mode() === "refine"
      ? Option.getOrElse(
          Option.map(store.refine().draft, (d) => String(d.slug)),
          () => props.ctx.runConfig.task,
        )
      : floor().task
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={tokens.accent.brand} flexShrink={0}>{glyph.brand}</text>
      <text fg={tokens.text.bright} flexShrink={0}>
        {store.mode() === "refine" ? "smith spec " : "smith "}
      </text>
      <text fg={tokens.text.dim} flexGrow={1} wrapMode="none">
        {title()}
      </text>
      <text fg={busyColor()} flexShrink={0}>{` ${heartbeat()}`}</text>
    </box>
  )
}

/** Refine mode: the dialog with the refiner. */
const Transcript = (props: { ctx: SmithTuiContext }) => {
  const refine = props.ctx.store.refine
  const visible = () => refine().transcript.slice(-TRANSCRIPT_ROWS)
  return (
    <box flexDirection="column" flexGrow={1} marginTop={1}>
      <text fg={tokens.text.dim}>refine</text>
      <Show
        when={visible().length > 0}
        fallback={
          <text fg={tokens.state.pending}>
            {"  describe what to build — the refiner drafts a spec you approve"}
          </text>
        }
      >
        <For each={visible()}>
          {(line) => (
            <text
              fg={line.who === "you" ? tokens.accent.input : tokens.text.default}
              wrapMode="word"
            >
              {line.who === "you" ? `${glyph.caret}${line.text}` : `  ${line.text}`}
            </text>
          )}
        </For>
      </Show>
      <Show when={refine().feed.length > 0}>
        <For each={refine().feed.slice(-4)}>
          {(label) => (
            <text fg={tokens.text.dim} wrapMode="none">{`    ${label}`}</text>
          )}
        </For>
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
    <box flexDirection="column" width={52} flexShrink={0} marginTop={1} marginLeft={2}>
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

/** The attempt × gate matrix — the factory floor's centrepiece. */
const AttemptPanel = (props: { ctx: SmithTuiContext }) => {
  const floor = props.ctx.store.floor
  return (
    <box flexDirection="column" width={46} flexShrink={0} marginTop={1}>
      <text fg={tokens.text.dim}>attempts</text>
      <Show
        when={floor().attempts.length > 0}
        fallback={<text fg={tokens.state.pending}>  (waiting for the first attempt)</text>}
      >
        <For each={floor().attempts}>
          {(row) => (
            <box flexDirection="row">
              <text fg={tokens.text.dim} flexShrink={0}>{`  #${row.attempt} `}</text>
              <For each={row.gates}>
                {(cell) => (
                  <text fg={cellColor(cell.state)} flexShrink={0} wrapMode="none">
                    {`${cellGlyph(cell.state)} ${cell.name}${cell.state === "fail" ? `(${cell.findings})` : ""}  `}
                  </text>
                )}
              </For>
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

/** The live activity feed — the coder's tool calls, spawns, retries. */
const Feed = (props: { ctx: SmithTuiContext }) => {
  const floor = props.ctx.store.floor
  const visible = () => floor().feed.slice(-FEED_ROWS)
  return (
    <box flexDirection="column" flexGrow={1} marginTop={1} marginLeft={2}>
      <text fg={tokens.text.dim}>activity</text>
      <For each={visible()}>
        {(line) => <text fg={tokens.text.default} wrapMode="none">{`  ${line}`}</text>}
      </For>
    </box>
  )
}

/** Outcome + roles + notice — the two quiet status rows above the input. */
const StatusRows = (props: { ctx: SmithTuiContext }) => {
  const { store } = props.ctx
  const roles = store.roles
  const floor = store.floor
  const outcome = () =>
    Option.getOrElse(
      Option.orElse(floor().outcome, () => floor().error),
      () => "",
    )
  const outcomeColor = () => (floor().phase === "done" ? tokens.state.ok : tokens.state.error)
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
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
          {`session ${Option.getOrElse(floor().conversationRef, () => "")} — open it in efferent with :browse`}
        </text>
      </Show>
      <box flexDirection="row">
        <text fg={tokens.text.dim} wrapMode="none" flexGrow={1}>
          {`● general ${roles.general}   code ${roles.code}   fast ${roles.fast}`}
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
    if (props.ctx.store.mode() === "refine" && props.ctx.sendRefine !== undefined) {
      props.ctx.sendRefine(value)
      return
    }
    props.ctx.store.setNotice("prefix commands with ':' (try :quit)")
  }
  const placeholder = () =>
    props.ctx.store.mode() === "refine"
      ? "refine the spec… — :lock when right, :forge to build, Ctrl-C quits"
      : ":quit · :model [code|fast] <p:m> · :set k v — Esc interrupts, Ctrl-C quits"
  return (
    <box flexDirection="row" flexShrink={0} marginTop={1}>
      <text fg={tokens.accent.input} flexShrink={0}>{glyph.caret}</text>
      <textarea
        ref={(renderable: TextareaRenderable) => {
          ref.current = renderable
          renderable.focus()
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

/** The factory: refine mode (transcript + live SpecPanel) flows into forge
 *  mode (the floor). Borderless, token-driven — the cli's layout language. */
export const App = (props: { ctx: SmithTuiContext }) => {
  useKeyboard((key) => dispatch(props.ctx, key))
  return (
    <box flexDirection="column" flexGrow={1} padding={1}>
      <Header ctx={props.ctx} />
      <Show
        when={props.ctx.store.mode() === "forge"}
        fallback={
          <box flexDirection="row" flexGrow={1}>
            <Transcript ctx={props.ctx} />
            <SpecPanel ctx={props.ctx} />
          </box>
        }
      >
        <box flexDirection="row" flexGrow={1}>
          <AttemptPanel ctx={props.ctx} />
          <Feed ctx={props.ctx} />
        </box>
      </Show>
      <StatusRows ctx={props.ctx} />
      <CommandLine ctx={props.ctx} />
    </box>
  )
}
