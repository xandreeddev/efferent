import { Effect, Option } from "effect"
import type { FileSystem } from "@xandreed/core"
import type { QualityBar } from "@xandreed/foundry"
import { loadForgeLessons, loadWorkspaceRules } from "../forge/session.js"
import { loadQualityBar } from "../gates/profile.js"
import { loadWorkspaceMemory } from "../memory/inject.js"
import type { ContextSet, StandingSource } from "./context-set.entity.js"
import { isStandingOn } from "./context-set.entity.functions.js"

/**
 * The STANDING sources — the harness's own context, loaded the way the
 * refiner and the forge always did, but GOVERNED by the context set: a
 * source switched off loads as None everywhere (refine, forge, follow-up),
 * so the human's choice is one choice. The measured sizes feed the panel.
 */

export interface StandingSources {
  readonly rules: Option.Option<string>
  readonly lessons: Option.Option<string>
  readonly memory: Option.Option<string>
  readonly doctrine: Option.Option<QualityBar>
  /** What each source would contribute (chars), whether it is on or off. */
  readonly measured: ReadonlyArray<{
    readonly name: StandingSource
    readonly on: boolean
    readonly chars: number
  }>
}

export const loadStandingSources = (
  cwd: string,
  set: ContextSet,
  configPath: Option.Option<string> = Option.none(),
): Effect.Effect<StandingSources, never, FileSystem> =>
  Effect.gen(function* () {
    const rules = yield* loadWorkspaceRules(cwd)
    const lessons = yield* loadForgeLessons(cwd)
    const memory = yield* loadWorkspaceMemory(cwd)
    const doctrine = yield* loadQualityBar(cwd, configPath)
    const gate = <A>(name: StandingSource, value: Option.Option<A>): Option.Option<A> =>
      isStandingOn(set, name) ? value : Option.none()
    const size = (value: Option.Option<string>): number =>
      Option.match(value, { onNone: () => 0, onSome: (t) => t.length })
    return {
      rules: gate("rules", rules),
      lessons: gate("lessons", lessons),
      memory: gate("memory", memory),
      doctrine: gate("doctrine", doctrine),
      measured: [
        { name: "rules", on: isStandingOn(set, "rules"), chars: size(rules) },
        { name: "lessons", on: isStandingOn(set, "lessons"), chars: size(lessons) },
        { name: "memory", on: isStandingOn(set, "memory"), chars: size(memory) },
        {
          name: "doctrine",
          on: isStandingOn(set, "doctrine"),
          chars: size(Option.map(doctrine, (bar) => bar.full)),
        },
      ],
    }
  })
