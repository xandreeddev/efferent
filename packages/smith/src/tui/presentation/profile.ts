import { Match, Option } from "effect"
import type { SmithEvent } from "../../domain/SmithEvent.js"

export interface ProfileState {
  readonly draftDir: Option.Option<string>
  readonly rules: ReadonlyArray<{ readonly rule: string; readonly findings: number }>
  readonly boundaryViolations: number
  readonly checks: ReadonlyArray<{ readonly name: string; readonly status: "green" | "red" }>
  readonly locked: boolean
  readonly configPath: Option.Option<string>
  readonly error: Option.Option<string>
}

export const initialProfile: ProfileState = {
  draftDir: Option.none(),
  rules: [],
  boundaryViolations: 0,
  checks: [],
  locked: false,
  configPath: Option.none(),
  error: Option.none(),
}

export const reduceProfile = (state: ProfileState, event: SmithEvent): ProfileState =>
  Match.value(event).pipe(
    Match.when({ type: "profile_draft" }, (draft) => ({
      ...state,
      draftDir: Option.some(draft.draftDir),
      rules: draft.rules,
      boundaryViolations: draft.boundaryViolations,
      checks: draft.checks,
      error: Option.none(),
    })),
    Match.when({ type: "profile_locked" }, (locked) => ({
      ...state,
      locked: true,
      configPath: Option.some(locked.configPath),
      error: Option.none(),
    })),
    Match.when({ type: "profile_error" }, (error) => ({
      ...state,
      error: Option.some(error.message),
    })),
    Match.orElse(() => state),
  )
