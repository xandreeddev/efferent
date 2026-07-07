import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { AgentMessage } from "@xandreed/engine"
import type { Check } from "./model.js"

/**
 * The manual DB/workspace audit, as combinators — each returns a `Check<W>`
 * for any world that structurally carries the evidence it reads. Checks
 * never fail as Effects: a missing file/conversation is a failing
 * CheckResult with detail.
 */

const ok = (pass: boolean, detail: string) => ({ pass, ...(pass ? {} : { detail }) })

/* ---- workspace fs (worlds with `dir`) ------------------------------ */

export const fileExists = <W extends { readonly dir: string }>(
  rel: string,
  severity: "hard" | "soft" = "hard",
): Check<W> => ({
  name: `file-exists:${rel}`,
  severity,
  run: (world) =>
    Effect.sync(() => ok(existsSync(join(world.dir, rel)), `${rel} does not exist`)),
})

export const fileContains = <W extends { readonly dir: string }>(
  rel: string,
  needle: string | RegExp,
  severity: "hard" | "soft" = "hard",
): Check<W> => ({
  name: `file-contains:${rel}`,
  severity,
  run: (world) =>
    Effect.sync(() => {
      const path = join(world.dir, rel)
      if (!existsSync(path)) return ok(false, `${rel} does not exist`)
      const text = readFileSync(path, "utf-8")
      const hit = typeof needle === "string" ? text.includes(needle) : needle.test(text)
      return ok(hit, `${rel} does not contain ${String(needle)}`)
    }),
})

/* ---- event trail (worlds with `events()`) --------------------------- */

interface Typed {
  readonly type: string
}

export const eventOrder = <W extends { readonly events: () => ReadonlyArray<Typed> }>(
  sequence: ReadonlyArray<string>,
  severity: "hard" | "soft" = "hard",
): Check<W> => ({
  name: `event-order:${sequence.join("→")}`,
  severity,
  run: (world) =>
    Effect.sync(() => {
      const types = world.events().map((e) => e.type)
      const matchedUpTo = sequence.reduce(
        (cursor, wanted) => {
          const at = types.indexOf(wanted, cursor.from)
          return at === -1 ? { from: cursor.from, matched: cursor.matched } : { from: at + 1, matched: cursor.matched + 1 }
        },
        { from: 0, matched: 0 },
      )
      return ok(
        matchedUpTo.matched === sequence.length,
        `matched ${matchedUpTo.matched}/${sequence.length} of [${sequence.join(", ")}] in [${types.join(", ")}]`,
      )
    }),
})

export const eventCount = <W extends { readonly events: () => ReadonlyArray<Typed> }>(
  type: string,
  bounds: { readonly min?: number; readonly max?: number },
  severity: "hard" | "soft" = "soft",
): Check<W> => ({
  name: `event-count:${type}`,
  severity,
  run: (world) =>
    Effect.sync(() => {
      const count = world.events().filter((e) => e.type === type).length
      const minOk = bounds.min === undefined || count >= bounds.min
      const maxOk = bounds.max === undefined || count <= bounds.max
      return ok(minOk && maxOk, `${type} occurred ${count}× (bounds ${JSON.stringify(bounds)})`)
    }),
})

/** A predicate over the finished event trail — the escape hatch for
 *  pack-specific evidence (outcome fields, payload shapes). */
export const eventWhere = <
  E extends Typed,
  W extends { readonly events: () => ReadonlyArray<E> } = { readonly events: () => ReadonlyArray<E> },
>(
  name: string,
  predicate: (events: ReadonlyArray<E>) => boolean,
  severity: "hard" | "soft" = "hard",
): Check<W> => ({
  name,
  severity,
  run: (world) =>
    Effect.sync(() => ok(predicate(world.events()), "predicate over the event trail failed")),
})

/* ---- persisted conversation (worlds exposing messages) --------------- */

const toolCallNames = (messages: ReadonlyArray<AgentMessage>): ReadonlyArray<string> =>
  messages.flatMap((m) =>
    m.role === "assistant"
      ? m.content.flatMap((p) => (p.type === "tool-call" ? [p.toolName] : []))
      : [],
  )

export const toolSequence = <W>(
  getMessages: (world: W) => Effect.Effect<ReadonlyArray<AgentMessage>>,
  sequence: ReadonlyArray<string>,
  mode: "subsequence" | "exact" = "subsequence",
  severity: "hard" | "soft" = "hard",
): Check<W> => ({
  name: `tool-sequence:${sequence.join("→")}`,
  severity,
  run: (world) =>
    getMessages(world).pipe(
      Effect.map((messages) => {
        const calls = toolCallNames(messages)
        if (mode === "exact") {
          return ok(
            calls.length === sequence.length && calls.every((c, i) => c === sequence[i]),
            `calls were [${calls.join(", ")}]`,
          )
        }
        const matched = sequence.reduce(
          (cursor, wanted) => {
            const at = calls.indexOf(wanted, cursor.from)
            return at === -1 ? cursor : { from: at + 1, matched: cursor.matched + 1 }
          },
          { from: 0, matched: 0 },
        )
        return ok(
          matched.matched === sequence.length,
          `matched ${matched.matched}/${sequence.length} of [${sequence.join(", ")}] in calls [${calls.join(", ")}]`,
        )
      }),
      Effect.catchAll((cause) =>
        Effect.succeed(ok(false, `conversation unavailable: ${String(cause).slice(0, 120)}`)),
      ),
    ),
})

/** Every assistant tool-call has a matching tool result (pairing integrity —
 *  the turn-alternation audit as a check). */
export const turnAlternationValid = <W>(
  getMessages: (world: W) => Effect.Effect<ReadonlyArray<AgentMessage>>,
  severity: "hard" | "soft" = "hard",
): Check<W> => ({
  name: "turn-alternation-valid",
  severity,
  run: (world) =>
    getMessages(world).pipe(
      Effect.map((messages) => {
        const callIds = messages.flatMap((m) =>
          m.role === "assistant"
            ? m.content.flatMap((p) => (p.type === "tool-call" ? [p.toolCallId] : []))
            : [],
        )
        const resultIds = new Set(
          messages.flatMap((m) =>
            m.role === "tool" ? m.content.map((p) => p.toolCallId) : [],
          ),
        )
        const orphans = callIds.filter((id) => !resultIds.has(id))
        return ok(orphans.length === 0, `tool calls without results: ${orphans.join(", ")}`)
      }),
      Effect.catchAll((cause) =>
        Effect.succeed(ok(false, `conversation unavailable: ${String(cause).slice(0, 120)}`)),
      ),
    ),
})

/** The FIRST user message (the brief a run was seeded with) matches. */
export const briefContains = <W>(
  getMessages: (world: W) => Effect.Effect<ReadonlyArray<AgentMessage>>,
  needle: string | RegExp,
  severity: "hard" | "soft" = "hard",
): Check<W> => ({
  name: `brief-contains:${String(needle).slice(0, 40)}`,
  severity,
  run: (world) =>
    getMessages(world).pipe(
      Effect.map((messages) => {
        const first = messages.find((m) => m.role === "user")
        if (first === undefined || first.role !== "user") {
          return ok(false, "no user message found")
        }
        const hit =
          typeof needle === "string" ? first.content.includes(needle) : needle.test(first.content)
        return ok(hit, `the brief does not contain ${String(needle)}`)
      }),
      Effect.catchAll((cause) =>
        Effect.succeed(ok(false, `conversation unavailable: ${String(cause).slice(0, 120)}`)),
      ),
    ),
})
