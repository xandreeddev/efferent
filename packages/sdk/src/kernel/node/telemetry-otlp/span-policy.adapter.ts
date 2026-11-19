import { Option, Tracer } from "effect"
import type { Context, Exit } from "effect"
import type { OtlpSpanPolicy } from "./otlp-telemetry.entity.js"

/** The policy with its defaults filled in; a hook that throws answers "drop". */
interface Hooks {
  readonly keep: (span: Tracer.Span) => boolean
  readonly attribute: (span: Tracer.Span, key: string, value: unknown) => Option.Option<unknown>
}

const hooksOf = (policy: OtlpSpanPolicy): Hooks => {
  const keep = Option.liftThrowable(policy.keep ?? (() => true))
  const attribute = Option.liftThrowable(policy.attribute ?? ((_span: Tracer.Span, _key: string, value: unknown) => Option.some(value)))
  return {
    keep: (span) => Option.getOrElse(keep(span), () => false),
    attribute: (span, key, value) => Option.flatten(attribute(span, key, value)),
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
    if (this.kept()) this.exported.end(endTime, exit)
  }

  attribute(key: string, value: unknown): void {
    if (this.status._tag === "Ended") return
    this.attributes.set(key, value)
    Option.match(this.hooks.attribute(this, key, value), { onNone: () => undefined, onSome: (sent) => this.exported.attribute(key, sent) })
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    if (this.status._tag === "Ended") return
    this.exported.event(name, startTime, attributes === undefined ? undefined : Object.fromEntries(Object.entries(attributes).flatMap(([key, value]) =>
      Option.match(this.hooks.attribute(this, key, value), { onNone: () => [], onSome: (sent) => [[key, sent] as const] }))))
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
 * leaves out never reaches `underlying`. Spans this tracer did not open (an
 * external parent) are kept as they are.
 */
export const spanPolicyTracer = (policy: OtlpSpanPolicy) => (underlying: Tracer.Tracer): Tracer.Tracer => {
  const hooks = hooksOf(policy)
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
