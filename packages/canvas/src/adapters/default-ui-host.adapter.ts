import { Effect, Layer, Schema } from "effect"
import { DesignTokensV1, UiHost } from "@xandreed/ui-agent"
import type { UiActionResult, UiCapability, UiRequestContext } from "@xandreed/ui-agent"
import tokensJson from "../../design-system.json"

const decodeEmpty = Schema.decodeUnknown(Schema.Record({ key: Schema.String, value: Schema.String }))

const capability = (
  run: (input: unknown, context: UiRequestContext) => Effect.Effect<UiActionResult, string>,
): UiCapability => ({
  decode: (input) => decodeEmpty(input).pipe(Effect.mapError((issue) => String(issue))),
  authorize: (_input, context) => context.sessionId.length > 0 ? Effect.void : Effect.fail("missing session"),
  run,
})

export const DefaultUiHostLive = Layer.effect(
  UiHost,
  Schema.decodeUnknown(DesignTokensV1)(tokensJson).pipe(
    Effect.mapError((issue) => new Error(`invalid Canvas design tokens: ${String(issue)}`)),
    Effect.map((tokens) => ({
      tokens,
      recipes: new Set(["landing.hero-grid", "app.workspace", "doc.architecture"]),
      assets: new Map(),
      actions: new Map<string, UiCapability>([
        [
          "canvas.acknowledge",
          capability(() => Effect.succeed({ blocks: [], notice: "Done." })),
        ],
        [
          "canvas.request-demo",
          capability(() =>
            Effect.succeed({
              blocks: [],
              notice: "Demo request accepted.",
            }),
          ),
        ],
      ]),
      queries: new Map<string, UiCapability>(),
    })),
  ),
)
