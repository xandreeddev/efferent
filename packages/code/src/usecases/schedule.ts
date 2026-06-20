import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { FileSystem } from "@xandreed/sdk-core"

/**
 * Cron scheduling: a JSON job list plus a per-minute tick that fires a fresh run
 * per due job. File-backed (no DB migration) and EFFERENT_HOME-aware. The tick
 * runs in the TUI runtime while it's up, and headless under `efferent daemon`.
 */
export interface ScheduledJob {
  readonly id: string
  /** 5-field cron: `min hour dom month dow`. */
  readonly cron: string
  /** Workspace the job belongs to (a tick only fires its own cwd's jobs). */
  readonly cwd: string
  /** Folder scope for the spawned run (relative to cwd). */
  readonly folder: string
  /** The task/prompt to run. */
  readonly prompt: string
  /** Optional agent role to run it as. */
  readonly agent?: string
  readonly createdAt: number
  /** Epoch ms of the last fire — guards against double-firing within a minute. */
  readonly lastRunMs?: number
}

/* ----------------------------- cron matching ---------------------------- */

interface CronField {
  readonly any: boolean
  readonly values: ReadonlySet<number>
}

interface CronFields {
  readonly minute: CronField
  readonly hour: CronField
  readonly dom: CronField
  readonly month: CronField
  readonly dow: CronField
}

const parseField = (raw: string, min: number, max: number): CronField | undefined => {
  if (raw === "*") return { any: true, values: new Set() }
  const values = new Set<number>()
  for (const part of raw.split(",")) {
    // step: a/b, */b, a-b/c
    const [rangePart, stepPart] = part.split("/")
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step <= 0) return undefined
    let lo = min
    let hi = max
    if (rangePart !== "*" && rangePart !== "" && rangePart !== undefined) {
      const [a, b] = rangePart.split("-")
      lo = Number(a)
      hi = b === undefined ? (stepPart === undefined ? lo : max) : Number(b)
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return undefined
    }
    if (lo < min || hi > max || lo > hi) return undefined
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values.size === 0 ? undefined : { any: false, values }
}

/** Parse a 5-field cron expression; undefined when malformed. */
export const parseCron = (expr: string): CronFields | undefined => {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return undefined
  const minute = parseField(f[0]!, 0, 59)
  const hour = parseField(f[1]!, 0, 23)
  const dom = parseField(f[2]!, 1, 31)
  const month = parseField(f[3]!, 1, 12)
  const dow = parseField(f[4]!, 0, 6) // 0 = Sunday
  if (!minute || !hour || !dom || !month || !dow) return undefined
  return { minute, hour, dom, month, dow }
}

const hit = (field: CronField, v: number): boolean => field.any || field.values.has(v)

/**
 * Whether `date` matches the cron fields. Day-of-month + day-of-week use the
 * standard cron OR semantics: when BOTH are restricted, either matching is a
 * hit; when only one is restricted, that one must match.
 */
export const cronMatches = (fields: CronFields, date: Date): boolean => {
  if (!hit(fields.minute, date.getMinutes())) return false
  if (!hit(fields.hour, date.getHours())) return false
  if (!hit(fields.month, date.getMonth() + 1)) return false
  const domR = !fields.dom.any
  const dowR = !fields.dow.any
  const domHit = hit(fields.dom, date.getDate())
  const dowHit = hit(fields.dow, date.getDay())
  if (domR && dowR) return domHit || dowHit
  return domHit && dowHit
}

/** Minute bucket of an epoch-ms time — fire at most once per matching minute. */
export const minuteBucket = (ms: number): number => Math.floor(ms / 60_000)

/* ------------------------------- job store ------------------------------ */

/** EFFERENT_HOME-aware path to the global cron job list. */
export const cronJobsPath = (): string =>
  join(process.env.EFFERENT_HOME ?? join(homedir(), ".efferent"), "cron.json")

export const loadJobs = (): Effect.Effect<ReadonlyArray<ScheduledJob>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const read = yield* fs.read(cronJobsPath()).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    if (read === undefined) return []
    try {
      const v = JSON.parse(read.content) as unknown
      return Array.isArray(v) ? (v as ReadonlyArray<ScheduledJob>) : []
    } catch {
      return []
    }
  })

export const saveJobs = (
  jobs: ReadonlyArray<ScheduledJob>,
): Effect.Effect<void, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    yield* fs
      .write(cronJobsPath(), JSON.stringify(jobs, null, 2))
      .pipe(Effect.catchAll(() => Effect.void))
  })

export const addJob = (job: ScheduledJob): Effect.Effect<void, never, FileSystem> =>
  loadJobs().pipe(Effect.flatMap((jobs) => saveJobs([...jobs, job])))

export const removeJob = (id: string): Effect.Effect<boolean, never, FileSystem> =>
  Effect.gen(function* () {
    const jobs = yield* loadJobs()
    const next = jobs.filter((j) => j.id !== id)
    yield* saveJobs(next)
    return next.length !== jobs.length
  })

export const markJobRun = (id: string, atMs: number): Effect.Effect<void, never, FileSystem> =>
  loadJobs().pipe(
    Effect.flatMap((jobs) =>
      saveJobs(jobs.map((j) => (j.id === id ? { ...j, lastRunMs: atMs } : j))),
    ),
  )

/** Parse `:schedule add` arg: `<cron> :: <folder> :: <prompt> [:: <agent>]`. */
export const parseScheduleArg = (
  arg: string,
): { cron: string; folder: string; prompt: string; agent?: string } | undefined => {
  const parts = arg.split("::").map((p) => p.trim())
  if (parts.length < 3) return undefined
  const [cron, folder, prompt, agent] = parts
  if (
    cron === undefined ||
    folder === undefined ||
    prompt === undefined ||
    cron.length === 0 ||
    prompt.length === 0
  ) {
    return undefined
  }
  if (parseCron(cron) === undefined) return undefined
  return {
    cron,
    folder: folder.length > 0 ? folder : ".",
    prompt,
    ...(agent !== undefined && agent.length > 0 ? { agent } : {}),
  }
}
