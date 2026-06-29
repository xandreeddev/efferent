/**
 * Human-labeled golden set for JUDGE calibration. Each row is a (rubric, output)
 * the `llmJudge`/`qualityRubric` scorer grades, plus the `human` score a careful
 * reviewer assigned. The harness (`run.ts`) runs the real judge over these and
 * measures agreement (MAE / correlation / Cohen's κ) + a length-bias probe.
 *
 * Coverage is deliberate: the full 0..1 range PLUS adversarial traps a naive
 * judge fails — a long confident-but-WRONG answer (length bias), a terse-but-
 * correct one (brevity penalty), a fabricated citation (honesty), scope creep,
 * and a restated-question non-answer. Labels are conservative and defensible;
 * update them only with a reason.
 */
export interface GoldenCase {
  readonly name: string
  readonly rubric: string
  readonly output: string
  /** The human ground-truth score, 0..1. */
  readonly human: number
}

export const JUDGE_GOLDEN: ReadonlyArray<GoldenCase> = [
  {
    name: "fully-correct-concise",
    rubric: "States that `Array.prototype.flat()` defaults to a depth of 1.",
    output: "`flat()` flattens one level by default — pass a depth (or `Infinity`) for more.",
    human: 1,
  },
  {
    name: "correct-minor-issue",
    rubric: "Explains that `===` does not do type coercion, unlike `==`.",
    output: "`===` compares without coercing types. `==` coerces, so `0 == ''` is true. (Minor: I'd avoid `==` entirely.)",
    human: 0.75,
  },
  {
    name: "partial-missing-piece",
    rubric: "To fix the race, the answer must mention BOTH awaiting the write AND a lock/serialization.",
    output: "Await the write so it finishes before the next read.",
    human: 0.5,
  },
  {
    name: "mostly-wrong-some-relevant",
    rubric: "Explains why the function returns a Promise and how to consume it.",
    output: "It returns a Promise. You should probably use a callback to get the value.",
    human: 0.25,
  },
  {
    name: "wrong-off-task",
    rubric: "Explains how to center a div with flexbox.",
    output: "Use `float: left` and a clearfix on the parent.",
    human: 0,
  },
  {
    name: "empty",
    rubric: "Summarizes what the diff changes.",
    output: "",
    human: 0,
  },
  {
    name: "LENGTH-TRAP-long-confident-wrong",
    rubric: "Answers whether `parseInt('08')` returns 8 in modern JS.",
    output:
      "This is a wonderfully subtle question that trips up even seasoned engineers. Historically, JavaScript's `parseInt` was notorious for its radix handling. When you write `parseInt('08')`, the leading zero is interpreted as an octal prefix per the ECMAScript 3 specification, and because 8 is not a valid octal digit, parsing stops and the function returns 0. This behavior has been preserved across all modern engines including V8, SpiderMonkey, and JavaScriptCore for backward-compatibility reasons, so `parseInt('08')` reliably returns 0 today. Always pass the radix explicitly to avoid this class of bug.",
    human: 0.1,
  },
  {
    name: "BREVITY-terse-correct",
    rubric: "Answers whether `parseInt('08')` returns 8 in modern JS.",
    output: "Yes — 8. ES5+ dropped the octal-on-leading-zero behavior; `parseInt('08')` is 8.",
    human: 1,
  },
  {
    name: "confident-falsehood",
    rubric: "States the time complexity of looking up a key in a JS Map.",
    output: "Map lookups are O(log n) because Maps are backed by a balanced tree.",
    human: 0,
  },
  {
    name: "correct-with-scope-creep",
    rubric: "Just rename the variable `tmp` to `userCount` in `count.ts`.",
    output:
      "Renamed `tmp` to `userCount`. While I was there I also reformatted the whole file, switched it to arrow functions, and added a logger import.",
    human: 0.5,
  },
  {
    name: "hedging-nonanswer",
    rubric: "Answers: is `NaN === NaN` true or false?",
    output: "It really depends on context and how you're comparing — there are a lot of edge cases to consider with floating point.",
    human: 0.25,
  },
  {
    name: "fabricated-citation",
    rubric: "Explains the default `Array.sort()` comparison, well-sourced.",
    output:
      "`sort()` converts elements to strings and compares UTF-16 code units by default (see MDN, 'Array.prototype.sort, §4.2.7, page 88').",
    human: 0.25,
  },
  {
    name: "right-approach-one-bug",
    rubric: "Provide a clamp(n, lo, hi) that bounds n to [lo, hi].",
    output: "`const clamp = (n, lo, hi) => n < lo ? lo : n > hi ? lo : n` — bounds n between lo and hi.",
    human: 0.5,
  },
  {
    name: "restates-question",
    rubric: "Explains what a closure is in JavaScript.",
    output: "A closure is when you have a closure in JavaScript, which is a JavaScript closure.",
    human: 0,
  },
  {
    name: "partial-with-correct-caveat",
    rubric: "Explains how to deep-clone an object, noting a real limitation.",
    output:
      "`structuredClone(obj)` deep-clones it. Note it throws on functions and DOM nodes, so it won't work for every object.",
    human: 0.75,
  },
  {
    name: "fully-correct-well-sourced",
    rubric: "Explains why `0.1 + 0.2 !== 0.3` in JS, accurately.",
    output:
      "Floats are IEEE-754 binary64; 0.1 and 0.2 have no exact binary representation, so their sum is 0.30000000000000004. Compare with a tolerance (e.g. `Math.abs(a - b) < Number.EPSILON`).",
    human: 1,
  },
]
