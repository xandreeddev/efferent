import { Show, createMemo } from "solid-js"
import { describeGrant, type ApprovalState } from "../../presentation/approvalView.js"
import type { Overlay as OverlayState, TuiContext } from "../../state/store.js"
import { tokens } from "../../state/theme.js"
import { Cursor, Sheet, SHEET_RULE, SHEET_WIDTH, Rule } from "../ui/index.js"

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/**
 * The bash-approval sheet — **borderless inline** in the bottom chrome (agy: no
 * floating modal): what will run, where, and four answers — three of which are
 * *grants* that stop future prompts (the out-of-bounds folder when the judge
 * named one, else the command-family rule). A judge escalation shows its reason
 * so the human reads WHY this one wasn't waved through. `d` switches to the
 * deny-reason line; the reason flows back to the model as the tool failure, so a
 * denial steers instead of stonewalling. Reads the active approval overlay from
 * the store; keys live in `keys/overlay.ts`.
 */
const ApprovalSheet = (props: { state: ApprovalState }) => {
  const s = () => props.state
  const rule = () => describeGrant(s())

  return (
    <Sheet title={`${s().request.tool} wants to run`} width={SHEET_WIDTH}>
      <text fg={tokens.text.default} wrapMode="none">
        {clip(s().request.summary, SHEET_WIDTH - 2)}
      </text>
      <text fg={tokens.text.dim} wrapMode="none">
        {`in ${s().request.cwd}`}
      </text>
      <Show when={s().hint?.reason !== undefined}>
        <text fg={tokens.text.muted} wrapMode="none">
          {clip(`judge: ${s().hint?.reason ?? ""}`, SHEET_WIDTH - 2)}
        </text>
      </Show>
      <Rule width={SHEET_RULE} />
      <Show
        when={s().mode === "deny"}
        fallback={
          <>
            <text fg={tokens.text.default}>{`a  allow once`}</text>
            <text fg={tokens.text.default}>{`s  allow ${rule()} for this session`}</text>
            <text fg={tokens.text.default}>{`p  always allow ${rule()} in this project`}</text>
            <text fg={tokens.text.default}>{`d  deny — tell the agent why`}</text>
            <Rule width={SHEET_RULE} />
            <text fg={tokens.text.muted}>{`a/s/p/d · esc deny`}</text>
          </>
        }
      >
        <box flexDirection="row">
          <text fg={tokens.text.muted}>{"reason: "}</text>
          <text fg={tokens.text.default} wrapMode="none">
            {s().reason}
          </text>
          <Cursor />
        </box>
        <Rule width={SHEET_RULE} />
        <text fg={tokens.text.muted}>{`type why (the agent reads it) · ↵ deny · esc back`}</text>
      </Show>
    </Sheet>
  )
}

export const ApprovalView = (props: { ctx: TuiContext }) => {
  const state = createMemo((): ApprovalState | undefined => {
    const o: OverlayState = props.ctx.store.overlay()
    return o.kind === "approval" ? o.state : undefined
  })
  return <Show when={state()}>{(st) => <ApprovalSheet state={st()} />}</Show>
}
