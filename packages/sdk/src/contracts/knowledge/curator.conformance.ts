import { Cause, Effect, Option } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck } from "@xandreed/core"
import { expect, fail, show, unexpected } from "../conformance.entity.functions.js"
import type { CurationJob } from "./curator.entity.js"
import type { Curator } from "./curator.port.js"
import { SourceId } from "./knowledge.entity.js"
import type { SourcePart } from "./knowledge.entity.js"
import { knowledgeOf } from "./knowledge.entity.functions.js"
import { curationPrompt, reviewPrompt } from "./knowledge-prompt.entity.functions.js"
import { shownFor } from "./knowledge-shown.entity.functions.js"

type CuratorShape = Context.Service.Shape<typeof Curator>

/**
 * A curator as the kit opens it: a fresh one per check, released with its scope.
 *
 * @public
 */
export interface CuratorSubject {
  readonly open: Effect.Effect<CuratorShape, never, Scope.Scope>
}

/** A small source to curate: one message of a user's and the answer to it, on 12 November 2026. */
const said: ReadonlyArray<SourcePart> = [
  { by: "user", text: "My friend Ana Silva works at Acme." },
  { by: "assistant", text: "Good to know." },
]
const source = SourceId.make("s1")

/** The prompt of a first call for that source, with nothing stored yet. */
const extract = curationPrompt({ said, at: 1_794_441_600_000 }, shownFor(knowledgeOf([]), { said }))

/** The prompt of a second call, that checks a reply to the first. */
const review = reviewPrompt(extract, `{"entities":[{"key":"a","name":"Ana Silva","kind":"person"}],"aliases":[],"memories":[],"restates":[],"forget":[]}`)

/**
 * The curator contract as a check: asked with a small prompt for each purpose, `extract` and `review`, it answers
 * with text that is not blank, or fails with `CurationFailed`; it never answers with nothing, fails with another
 * error or dies (`answers`). What a curator answers is read as a curation and stored; a blank answer would be
 * read as a source that adds nothing, when the model said nothing at all.
 *
 * @public
 */
export const curatorConformance = (subject: CuratorSubject): ReadonlyArray<ConformanceCheck> => {
  const asked = (curator: CuratorShape, prompt: string, job: CurationJob) => {
    const what = `a curator asked to ${job.purpose}`
    return curator.curate({ prompt, job }).pipe(
      Effect.matchCauseEffect({
        onSuccess: (reply) => expect("answers", reply.trim().length > 0, `${what} answered with nothing: ${show(reply)}`),
        onFailure: (cause) => Option.match(Cause.findErrorOption(cause), {
          onNone: () => fail("answers", `${what} died or was interrupted, where it may only fail with CurationFailed`),
          onSome: (error) => expect("answers", error._tag === "CurationFailed", `${what} failed with ${error._tag}, not CurationFailed`),
        }),
      }),
    )
  }
  return [{
    id: "answers",
    name: "it answers with text that is not blank, or fails with CurationFailed, for a first call and for a review",
    run: Effect.scoped(Effect.gen(function* () {
      const curator = yield* subject.open
      yield* asked(curator, extract, { source, attempt: 1, purpose: "extract" })
      yield* asked(curator, review, { source, attempt: 1, purpose: "review" })
    })).pipe(unexpected("answers")),
  }]
}
