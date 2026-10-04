import type { SessionLogEvent } from "@xandreed/core"
import type { Option } from "effect"
import type { JournalTurn, TranscriptBlock } from "./presentation.entity.js"

/** Host formatters interpret their own namespaced records into presentation values. */
export type JournalRenderer = (event: SessionLogEvent, turn: Option.Option<JournalTurn>) => ReadonlyArray<TranscriptBlock>
export type JournalRenderers = Readonly<Record<string, JournalRenderer>>
