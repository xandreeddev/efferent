import { Schema } from "effect"
import { SessionId, storedEvent, TurnNumber } from "@xandreed/core/kernel"

/**
 * A fact's name: `f` and a number (`f3`), short enough for a model to write back. The memory session mints it, one
 * more than the number of facts it ever learned, so no two facts share one.
 *
 * @public
 */
export const FactId = Schema.String.check(Schema.isPattern(/^f[1-9][0-9]{0,8}$/)).pipe(Schema.brand("FactId"))
export type FactId = typeof FactId.Type

/**
 * The most characters of a fact. A fact is a model's text, sent again in every later conversation: one that is
 * longer is refused, in words the model reads, and never cut, since a cut fact says something else.
 *
 * @public
 */
export const FACT_LIMIT = 300

/**
 * What a fact says: one line of 1 to `FACT_LIMIT` characters, with no space at either end. One line, since facts
 * are listed to the model a line each, and a second line could pass for another fact: no character that ends a
 * line is in it (a line feed, a carriage return, a vertical tab, a form feed, U+0085, U+2028 or U+2029).
 *
 * @public
 */
export const FactText = Schema.String.check(Schema.isPattern(/^(?![^]*[\n\r\v\f\u0085\u2028\u2029])\S(?:[^]*\S)?$/), Schema.isMaxLength(FACT_LIMIT))
export type FactText = typeof FactText.Type

/**
 * The data of `plugin.facts.learned`: the fact, and the conversation and turn it was learned in.
 *
 * @public
 */
export const LearnedData = Schema.Struct({ id: FactId, text: FactText, from: Schema.Struct({ session: SessionId, turn: TurnNumber }) })
export type LearnedData = typeof LearnedData.Type

/**
 * A fact that stands: what `factsOf` gives. It is the data of the record that learned it.
 *
 * @public
 */
export type Fact = LearnedData

/**
 * `plugin.facts.learned`: a fact was remembered (ADR 0014). Stored in the memory session, a journal of its own,
 * tagged `memory`. A reader of facts that does not know it must not pass over it.
 *
 * @public
 */
export const learnedEvent = storedEvent("facts", "learned", { data: LearnedData, skippable: false, tags: ["memory"] })

/**
 * The data of `plugin.facts.forgotten`: the fact that no longer stands.
 *
 * @public
 */
export const ForgottenData = Schema.Struct({ id: FactId })
export type ForgottenData = typeof ForgottenData.Type

/**
 * `plugin.facts.forgotten`: a fact no longer stands. Stored in the memory session, tagged `memory`. A reader of
 * facts that does not know it must not pass over it: it would go on giving a fact that was forgotten.
 *
 * @public
 */
export const forgottenEvent = storedEvent("facts", "forgotten", { data: ForgottenData, skippable: false, tags: ["memory"] })

/**
 * The owner of the memory session: the journal that holds an agent's facts. A name in the plugin's own words, so
 * no session a host creates takes it by chance.
 *
 * @public
 */
export const FACTS_OWNER = "plugin.facts"

/**
 * The name of the tool that remembers a fact.
 *
 * @public
 */
export const REMEMBER_FACT = "rememberFact"

/**
 * The name of the tool that forgets a fact.
 *
 * @public
 */
export const FORGET_FACT = "forgetFact"

/**
 * What `rememberFact` answers: the fact's id, and nothing of its text, which the call already holds.
 *
 * @public
 */
export const RememberedFact = Schema.Struct({ id: FactId })
export type RememberedFact = typeof RememberedFact.Type

/**
 * The options of `withFacts`: at most how many facts a request is sent.
 *
 * @public
 */
export interface FactsOptions {
  readonly limit: number
}
