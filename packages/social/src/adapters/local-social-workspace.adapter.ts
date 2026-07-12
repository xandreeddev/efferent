import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { decodeJsonLines, parseJsonWarn } from "@xandreed/engine"
import { LedgerEntry } from "../domain/ledger.entity.js"
import type { LedgerError } from "../domain/ledger.entity.js"
import { DEFAULT_POLICY, SocialPolicy } from "../domain/social-policy.entity.js"
import { SocialWorkspace } from "../ports/social-workspace.port.js"

const decodeEntry = Schema.decodeUnknownEither(LedgerEntry)
const decodePartialPolicy = Schema.decodeUnknownEither(Schema.partial(SocialPolicy))
const failure = (message: string): LedgerError => ({ _tag: "LedgerError", message })

export const readLedger = (path: string): Effect.Effect<ReadonlyArray<LedgerEntry>> =>
  Effect.tryPromise({ try: () => readFile(path, "utf-8"), catch: () => "missing" as const }).pipe(
    Effect.map((text) => decodeJsonLines(text, decodeEntry)),
    Effect.orElseSucceed(() => []),
  )

export const appendLedger = (
  path: string,
  entry: LedgerEntry,
): Effect.Effect<void, LedgerError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8")
    },
    catch: (error) => failure(`ledger append failed: ${String(error)}`),
  })

export const loadPolicy = (path: string): Effect.Effect<SocialPolicy> =>
  Effect.tryPromise({ try: () => readFile(path, "utf-8"), catch: () => "missing" as const }).pipe(
    Effect.flatMap((text) => parseJsonWarn(text, path)),
    Effect.map((maybe) =>
      Option.match(maybe, {
        onNone: () => DEFAULT_POLICY,
        onSome: (parsed) => {
          const overlay = decodePartialPolicy(parsed)
          return overlay._tag === "Left"
            ? DEFAULT_POLICY
            : {
                ...DEFAULT_POLICY,
                ...Object.fromEntries(
                  Object.entries(overlay.right).filter(([, value]) => value !== undefined),
                ),
              }
        },
      }),
    ),
    Effect.orElseSucceed(() => DEFAULT_POLICY),
  )

export const writeDraft = (path: string, content: string): Effect.Effect<void, LedgerError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, "utf-8")
    },
    catch: (error) => failure(`draft write failed: ${String(error)}`),
  })

export const LocalSocialWorkspaceLive = Layer.succeed(SocialWorkspace, {
  readLedger,
  appendLedger,
  loadPolicy,
  writeDraft,
})
