import { Show } from "solid-js"
import { describeRule, type ApprovalState } from "../../presentation/approvalView.js"
import { tokens } from "../../state/theme.js"
import { Cursor, Modal, MODAL_RULE, MODAL_WIDTH, Rule } from "../ui/index.js"

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/**
 * The bash-approval modal: what will run, where, and four answers — three of
 * which are *rules* that stop future prompts for the same command family.
 * `d` switches to the deny-reason line; the reason flows back to the model as
 * the tool failure, so a denial steers instead of stonewalling. Keys live in
 * `keys/overlay.ts`; this just renders the pure `ApprovalState`.
 */
export const ApprovalView = (props: { state: ApprovalState }) => {
  const s = () => props.state
  const rule = () => describeRule(s().request.ruleKey)

  return (
    <Modal title={` ${s().request.tool} wants to run `} width={MODAL_WIDTH}>
      <text fg={tokens.text.default} wrapMode="none">
        {clip(s().request.summary, MODAL_WIDTH - 4)}
      </text>
      <text fg={tokens.text.dim} wrapMode="none">
        {`in ${s().request.cwd}`}
      </text>
      <Rule width={MODAL_RULE} />
      <Show
        when={s().mode === "deny"}
        fallback={
          <>
            <text fg={tokens.text.default}>{`a  allow once`}</text>
            <text fg={tokens.text.default}>{`s  allow ${rule()} for this session`}</text>
            <text fg={tokens.text.default}>{`p  always allow ${rule()} in this project`}</text>
            <text fg={tokens.text.default}>{`d  deny — tell the agent why`}</text>
            <Rule width={MODAL_RULE} />
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
        <Rule width={MODAL_RULE} />
        <text fg={tokens.text.muted}>{`type why (the agent reads it) · ↵ deny · esc back`}</text>
      </Show>
    </Modal>
  )
}
