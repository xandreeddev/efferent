import { Array as Arr, Effect, Option, Order } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { PromptTier } from "../harness/capability.entity.js"
import type { PromptContext, PromptSection } from "../ports/capability.port.js"

const tierRank: Record<PromptTier, number> = { static: 0, session: 1, turn: 2 }

/** Tier, then order, then id by code unit: the same prompt bytes under every locale. */
const bySection: Order.Order<PromptSection> = Order.combineAll([
  Order.mapInput(Order.Number, (section: PromptSection) => tierRank[section.tier]),
  Order.mapInput(Order.Number, (section: PromptSection) => section.order),
  Order.mapInput(Order.String, (section: PromptSection) => section.id),
])

/** Static sections first (the cacheable prefix), then session ones; each tier by order, then id. */
export const orderSections = (sections: ReadonlyArray<PromptSection>): ReadonlyArray<PromptSection> =>
  Arr.sort(sections, bySection)

/** Render sections in order; a section that renders None is left out. Their requirements are the caller's. */
export const renderSections = (
  sections: ReadonlyArray<PromptSection>,
  context: PromptContext,
): Effect.Effect<ReadonlyArray<{ readonly section: PromptSection; readonly text: string }>, HarnessError, unknown> =>
  Effect.forEach(orderSections(sections), (section) => section.render(context).pipe(
    Effect.map((text) => Option.map(text, (value) => ({ section, text: value }))),
  )).pipe(Effect.map((rendered) => rendered.flatMap(Option.toArray)))
