# ADR 0015: A model call is planned, and an answer is made once

- **Status:** accepted, 15 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (the turn contract: `planned`, `retryable`, `AnswerCut`,
  `plugin.model.attempt`; the scripted model's failures)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

A model call fails: a rate limit, a provider's own error, a lost connection, a GPU that is
gone. A host wants to try the call again, a moment later, and then to hand it to another
model. Four things had to be decided: where that is written, what may be tried again, what
the turn keeps of it, and how a client sees it.

Effect 4.0.7 has the mechanism: an `ExecutionPlan` is a list of steps, each providing a
service and saying how often to try it, on what schedule and while what holds;
`Stream.withExecutionPlan` runs a stream under one. It is marked unstable.

A model's answer is a stream that a reader is handed piece by piece (`modelAnswer`, with
`onText` for a chat that shows it as it comes). A piece once shown cannot be taken back.

## Decision

- **The plan is Effect's.** A host writes it with `ExecutionPlan.make({ provide, attempts,
  schedule, while }, …)`: each step provides a model. The loop applies it to the stream it
  asks for, through the kernel's `planned(plan)`, before `modelAnswer` reads it:
  `LanguageModel.streamText(…).pipe(planned(plan))`. The model the call needs is then the
  plan's: a program that runs it needs no model of its own, and a plan whose steps provide
  none leaves the call needing one, which does not compile.
- **An answer is made once.** `planned` holds the parts before the first one that hands on
  content (a piece of text or a call): an attempt that fails before any has handed on
  nothing, and the plan tries it again or hands it to the next step. Once content went on, a
  failure is final, for every step, with a `while` or without: the call fails with
  `AnswerCut`, and the model is not asked again. Effect's `preventFallbackOnPartialStream`
  does not hold this rule: it counts a stream's start as output (a model that started and
  failed would never be handed on), and it does not stop a step from trying again after a
  word (the reader would see the word twice). Tests pin both.
- **An error the model reports inside its stream**, before any content, fails the attempt
  with `ModelAnswerFailed`, as `modelAnswer` would fail the call: Effect's providers report
  a provider's overload mid-stream as an error part, not as a failure of the stream, and the
  plan must see it to hand the call on. After content, an error part cuts the answer as a
  failed stream does: `AnswerCut`.
- **A step's `while` reads what an attempt fails with**: the model's own error, or
  `ModelAnswerFailed`. A `while` typed over `AiError` alone does not compile; one over both,
  or over anything (`retryable`), does.
- **What is worth another try** is said by the host's `while`. The kernel's `retryable(error)`
  is an `AiError` whose reason says so (a rate limit, a provider's own error, a lost
  connection); an unknown error, a refused request and anything that is no `AiError` are not,
  `ModelAnswerFailed` among them (an error part does not say whether it is worth another
  try): a plan hands such an attempt to its next step.
  A prompt too long is never tried again: a memory that cannot fit the budget fails before
  the call (`OverBudget`).
- **Not tried again either:** a defect (Effect's plan does not retry one); Stop, which
  interrupts the call at once, the wait between attempts included, and the turn closes
  `Interrupted`; a reader that fails (an `onText` that fails), which ends the call, its
  attempt said `failed` in the reader's words.
- **Each attempt is said, live.** `plugin.model.attempt` (tagged `trace`) says that an
  attempt started, succeeded or failed (with the failure's words), its count from one and
  its step, about the turn the call is for, through `CurrentTurn` (which `modelAnswer`
  provides). A call with no turn says nothing. Nothing of it is stored: a call that was tried
  again and answered leaves the same journal as one that answered at once. A host that must
  count retries stores a record of its own from the plan's events.
- **A publish that fails is logged**, as a warning, and never fails the call: `planned`
  ignores the failure of each attempt's publish itself, and a test pins the warning. This
  differs from a model wrapper's own publish (ADR 0007), which fails its turn.
- **A schedule is the host's, and fixed.** A rate limit's `retryAfter` is not read: a step
  waits as its `schedule` says. A host that must honour it writes a schedule that reads
  the failure.
- **Each model call is planned anew:** a turn's second call starts at the plan's first step,
  and counts its attempts from one.
- **The answer's record names the model that answered** when its stream names itself: the
  name a failed attempt gave is not kept, because its parts were held and dropped.
- **No kit.** Nothing here is a contract a host implements. The scripted model fails as its
  script says, worth another try or not, before anything or after some pieces, so a host
  tests its plan without a provider. It does not report an error inside its stream: that
  rule is tested with a model of the test's own.

## Rejected

- **Wrappers of `LanguageModel` composed in `main`** (`retrying(policy)`,
  `fallingBackTo(other)`), the first sketch. A wrapper forwards `streamText`, whose type is a
  set of generic overloads: a forwarding form that compiles needs a cast, which the kernel
  does not write around a model (one form tried). Effect already has the mechanism.
- **A retry inside `modelAnswer`.** The reader of an answer would also decide when a model
  is asked again, and a loop that reads its answer another way would lose the rule.
- **Trying the whole turn again.** Its records (the user's message, tool results) would be
  stored twice, and a tool would act twice.
- **Storing each attempt.** A record per failure in the conversation's journal is read by
  every fold and kept forever, for what a client needs only while it happens.
- **Effect's `preventFallbackOnPartialStream` alone**, for the reasons above.
