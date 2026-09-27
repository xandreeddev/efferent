import { Context } from "effect"
import type { Option, Ref } from "effect"

/** Per-run state the composable-host tests keep for their own policy. */
export class Delivered extends Context.Tag("test/Delivered")<Delivered, Ref.Ref<Option.Option<string>>>() {}
