// Lesson 9's experiments edit the learner's code in place, so the code and
// the buttons never disagree. A line the learner rewrote beyond recognition
// is left alone (None) rather than guessed at.
import { Option } from "effect"
import { APPROVAL_LINE } from "./agent.source.ts"
import { ASK } from "./tools.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** main's line with a policy before the person: it allows every request, so nobody is asked. */
export const POLICY_LINE = "  Effect.provide(autoApprove(() => true)(approvalOn(pane))), // a policy answers: nobody is asked\n"

/** agent.ts with a policy around the page's approval: every request is answered `Allowed`, and the person is never asked. */
export const autoApproved = swap(APPROVAL_LINE, POLICY_LINE)

/** What main says where its approval was. */
export const NOBODY_LINE = "  // No approval is given here: a tool that asks has nobody to ask.\n"

/** agent.ts whose main provides no approval: the page runs it, and TypeScript would refuse it. */
export const noApproval = swap(APPROVAL_LINE, NOBODY_LINE)

/** The base's line that runs a call. */
const RUN_CALL = "          yield* callTool(toolkit, call, session)\n"

/** The same step, asked for first: the loop asks before every call, and stores a refusal as the call's result. */
export const ASK_THEN_RUN = `          // The loop asks before every call, whatever the tool. A refusal is stored as the call's
          // result: a call with no result is not sent again, so the model would never read the no.
          yield* approveIn(session, {
            action: \`tool.\${call.name}\`,
            detail: \`Call \${call.name} with \${JSON.stringify(call.params)}.\`,
          }).pipe(
            Effect.matchEffect({
              onFailure: (refusal) => session.append(toolResult(call, refusal, true)),
              onSuccess: () => callTool(toolkit, call, session),
            }),
          )
`

/** agent.ts whose loop asks before it runs any call: `forget` is then asked for twice, by the loop and by the tool. */
export const askInLoop = swap(RUN_CALL, ASK_THEN_RUN)

/** tools.ts whose `forget` no longer asks: the notes are deleted on the model's word. */
export const noAsk = swap(ASK, "")
