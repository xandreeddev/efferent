import { Effect, Option } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { PromptContext, PromptSection } from "../ports/capability.port.js"

const tierRank = (section: PromptSection): number => section.tier === "static" ? 0 : section.tier === "session" ? 1 : 2

/** Static sections first (the cacheable prefix), then session ones; each tier by order, then id. */
export const orderSections = (sections: ReadonlyArray<PromptSection>): ReadonlyArray<PromptSection> =>
  [...sections].sort((left, right) => tierRank(left) - tierRank(right) || left.order - right.order || left.id.localeCompare(right.id))

/** Render sections in order; a section that renders None is left out. Their requirements are the caller's. */
export const renderSections = (
  sections: ReadonlyArray<PromptSection>,
  context: PromptContext,
): Effect.Effect<ReadonlyArray<{ readonly section: PromptSection; readonly text: string }>, HarnessError, unknown> =>
  Effect.forEach(orderSections(sections), (section) => section.render(context).pipe(
    Effect.map((text) => Option.map(text, (value) => ({ section, text: value }))),
  )).pipe(Effect.map((rendered) => rendered.flatMap(Option.toArray)))
