/**
 * Excerpts of the reviewer's own source for the /review pages, cut from the files as they are, so a snippet the pages
 * show is the code that runs: a file renamed or a line rewritten fails the build here instead of leaving a stale copy.
 *
 * The pages publish no measurement, cost or model of the reviewer's, and say "turn" and "step": an excerpt that holds
 * any of those (a comment that cites a run, a dollar figure, a model's name, an old word) fails the build too.
 */
import cliAdapter from "../../../review/src/cli.adapter.ts?raw"
import prepareEntity from "../../../review/src/prepare-review.entity.ts?raw"
import reviewPromptEntity from "../../../review/src/review-prompt.entity.ts?raw"
import reviewToolsAdapter from "../../../review/src/review-tools.adapter.ts?raw"
import reviewTurnAdapter from "../../../review/src/review-turn.adapter.ts?raw"
import reviewTurnPort from "../../../review/src/review-turn.port.ts?raw"
import sandboxesPort from "../../../review/src/sandboxes.port.ts?raw"
import stageSpendPort from "../../../review/src/stage-spend.port.ts?raw"
import validationsAdapter from "../../../review/src/validations.adapter.ts?raw"
import forgePort from "../../../review/src/forge.port.ts?raw"

const SOURCES = {
  "cli.adapter.ts": cliAdapter,
  "prepare-review.entity.ts": prepareEntity,
  "review-prompt.entity.ts": reviewPromptEntity,
  "review-tools.adapter.ts": reviewToolsAdapter,
  "review-turn.adapter.ts": reviewTurnAdapter,
  "review-turn.port.ts": reviewTurnPort,
  "sandboxes.port.ts": sandboxesPort,
  "stage-spend.port.ts": stageSpendPort,
  "validations.adapter.ts": validationsAdapter,
  "forge.port.ts": forgePort,
} as const

export type ReviewSource = keyof typeof SOURCES

/** What no excerpt may hold: a dollar figure, a pull request's number, an eval's words, a model's name, the old word for a turn. */
const BANNED: ReadonlyArray<RegExp> = [/\$\d/, /#\d{2,}/, /\bgold\b/i, /deepseek|flash|sonnet|haiku|opus|\bsol\b|gpt|baseten/i, /\bpass(es)?\b/i]

/**
 * The lines of `file` from the first that holds `from` to the first after it that holds `to`, both included, with
 * the comment lines (`//`) inside left out when `comments` is false. Fails the build when either line is missing or
 * the excerpt holds a banned word.
 */
export const excerpt = (file: ReviewSource, from: string, to: string, options: { readonly comments?: boolean } = {}): string => {
  const lines = SOURCES[file].split("\n")
  const start = lines.findIndex((line) => line.includes(from))
  if (start < 0) throw new Error(`review-source: ${file} holds no line with ${JSON.stringify(from)}`)
  const end = lines.findIndex((line, at) => at >= start && line.includes(to))
  if (end < 0) throw new Error(`review-source: ${file} holds no line with ${JSON.stringify(to)} after ${JSON.stringify(from)}`)
  const kept = lines.slice(start, end + 1).filter((line) => options.comments !== false || !/^\s*\/\//.test(line))
  const text = kept.join("\n")
  const banned = BANNED.find((pattern) => pattern.test(text))
  if (banned !== undefined) throw new Error(`review-source: the excerpt of ${file} from ${JSON.stringify(from)} holds ${banned}`)
  return text
}
