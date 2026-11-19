import { Cause, Exit, Option, Predicate, Tracer } from "effect"
import type { Context } from "effect"
import type { OtlpSpanPolicy } from "./otlp-telemetry.entity.js"

/** The policy with its defaults filled in; a hook that throws answers "drop". */
interface Hooks {
  readonly keep: (span: Tracer.Span) => boolean
  readonly attribute: (span: Tracer.Span, key: string, value: unknown) => Option.Option<unknown>
  /** Whether a failure's words and a log's text are kept from the exporter (the export's `content` off). */
  readonly withhold: boolean
}

/** What the exporter is told of a failure while its words are withheld, in place of its message. */
export const WITHHELD = "the error's words are not sent: the export's content is off"

/**
 * A failure as the exporter sees it while its words are withheld: its type alone (an error's tag, and its reason's
 * when it has one, as `AiError.InvalidRequestError`; else its class's name, or what kind of value it is), the
 * fixed words of `WITHHELD`, a stack of that one line and no cause, which the exporter would write out.
 */
class Withheld extends Error {
  constructor(type: string) {
    super(WITHHELD)
    this.name = type
    this.stack = `${type}: ${WITHHELD}`
  }
}

/** A failure's type, never its words. */
const typeOf = (failure: unknown): string => {
  const tag = Predicate.hasProperty(failure, "_tag") && Predicate.isString(failure._tag) ? Option.some(failure._tag) : Option.none<string>()
  const reason = Predicate.hasProperty(failure, "reason") && Predicate.hasProperty(failure.reason, "_tag") && Predicate.isString(failure.reason._tag)
    ? Option.some(failure.reason._tag)
    : Option.none<string>()
  return Option.match(tag, {
    onSome: (named) => Option.match(reason, { onNone: () => named, onSome: (why) => `${named}.${why}` }),
    onNone: () => failure instanceof Error ? failure.constructor.name : typeof failure,
  })
}

/**
 * An exit as the exporter is handed it while words are withheld: a success and an interruption as they are, each
 * failure and defect as a `Withheld` of its type, so the span's status message and its `exception` events say what
 * kind of failure ended it and nothing it said (an error can quote the request it refused, prompt and all).
 */
export const withheldExit = (exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> =>
  Exit.isSuccess(exit) ? exit : Exit.failCause(Cause.fromReasons(exit.cause.reasons.map((reason) =>
    Cause.isFailReason(reason) ? Cause.makeFailReason(new Withheld(typeOf(reason.error)))
      : Cause.isDieReason(reason) ? Cause.makeDieReason(new Withheld(typeOf(reason.defect)))
        : reason)))

/** The attributes a log's span event keeps while words are withheld: its level and its fiber, never its text or cause. */
const LOG_KEPT: ReadonlyArray<string> = ["effect.logLevel", "effect.fiberId"]

const hooksOf = (policy: OtlpSpanPolicy, withhold: boolean): Hooks => {
  const keep = Option.liftThrowable(policy.keep ?? (() => true))
  const attribute = Option.liftThrowable(policy.attribute ?? ((_span: Tracer.Span, _key: string, value: unknown) => Option.some(value)))
  return {
    keep: (span) => Option.getOrElse(keep(span), () => false),
    attribute: (span, key, value) => Option.flatten(attribute(span, key, value)),
    withhold,
  }
}

/**
 * The span Effect holds: its own status, its logical parent (the span it
 * was opened under) and every attribute set on it, as the program and the
 * hooks read them; the policy stands between it and `exported`, the span
 * of the underlying tracer, opened under the nearest kept ancestor, which
 * gets only the attribute values the policy lets through. A dropped span
 * never ends `exported`, so the underlying tracer never sends it.
 */
class PolicySpan implements Tracer.Span {
  readonly _tag = "Span"
  readonly attributes = new Map<string, unknown>()
  status: Tracer.SpanStatus
  private decision: Option.Option<boolean> = Option.none()

  constructor(
    readonly exported: Tracer.Span,
    readonly parent: Option.Option<Tracer.AnySpan>,
    private readonly hooks: Hooks,
  ) {
    this.status = exported.status
  }

  get name(): string { return this.exported.name }
  get spanId(): string { return this.exported.spanId }
  get traceId(): string { return this.exported.traceId }
  get annotations(): Context.Context<never> { return this.exported.annotations }
  get links(): ReadonlyArray<Tracer.SpanLink> { return this.exported.links }
  get sampled(): boolean { return this.exported.sampled }
  get kind(): Tracer.SpanKind { return this.exported.kind }

  /** The policy's `keep`, asked once: when the first child starts or the span ends. */
  kept(): boolean {
    return Option.getOrElse(this.decision, () => {
      const kept = this.hooks.keep(this)
      this.decision = Option.some(kept)
      return kept
    })
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") return
    this.status = { _tag: "Ended", startTime: this.status.startTime, endTime, exit }
    if (this.kept()) this.exported.end(endTime, this.hooks.withhold ? withheldExit(exit) : exit)
  }

  attribute(key: string, value: unknown): void {
    if (this.status._tag === "Ended") return
    this.attributes.set(key, value)
    Option.match(this.hooks.attribute(this, key, value), { onNone: () => undefined, onSome: (sent) => this.exported.attribute(key, sent) })
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    if (this.status._tag === "Ended") return
    // A log Effect wrote on the span (its tracer logger's event: the message as its name, the cause as an attribute)
    // is sent as `log`, its level and fiber alone, while words are withheld: a host's log can say what was said.
    const log = this.hooks.withhold && attributes !== undefined && Object.hasOwn(attributes, "effect.logLevel")
    const kept = attributes === undefined ? undefined : Object.fromEntries(Object.entries(attributes).flatMap(([key, value]) =>
      log && !LOG_KEPT.includes(key) ? [] : Option.match(this.hooks.attribute(this, key, value), { onNone: () => [], onSome: (sent) => [[key, sent] as const] })))
    this.exported.event(log ? "log" : name, startTime, kept)
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    if (this.status._tag === "Ended") return
    this.exported.addLinks(links)
  }
}

/**
 * `underlying` (the OTLP tracer) behind a span policy: a span `keep`
 * refuses is never ended on `underlying`, so never sent, and its children
 * open under its nearest kept ancestor there; an attribute `attribute`
 * leaves out never reaches `underlying`. With `withhold`, a span's failure
 * reaches `underlying` as its type alone (`withheldExit`) and a log's event
 * as `log` with its level. Spans this tracer did not open (an external
 * parent) are kept as they are.
 */
export const spanPolicyTracer = (policy: OtlpSpanPolicy, options: { readonly withhold?: boolean } = {}) => (underlying: Tracer.Tracer): Tracer.Tracer => {
  const hooks = hooksOf(policy, options.withhold === true)
  const opened = new WeakMap<Tracer.AnySpan, PolicySpan>()
  const exportedParent = (parent: Option.Option<Tracer.AnySpan>): Option.Option<Tracer.AnySpan> => Option.flatMap(parent, (span) =>
    Option.match(Option.fromNullishOr(opened.get(span)), {
      onNone: () => Option.some(span),
      onSome: (own) => own.kept() ? Option.some<Tracer.AnySpan>(own.exported) : exportedParent(own.parent),
    }))
  return Tracer.make({
    ...(underlying.context === undefined ? {} : { context: underlying.context }),
    span(options) {
      const span = new PolicySpan(underlying.span({ ...options, parent: exportedParent(options.parent) }), options.parent, hooks)
      opened.set(span, span)
      return span
    },
  })
}
