import { Effect, Match, Option, Schema } from "effect"
import { parseModelSelection, ReasoningEffort } from "@xandreed/core"
import { EngineSettings, SETTINGS_KEYS, SettingsError } from "@xandreed/core/models"
import type { ModelRole, SettingsKey } from "@xandreed/core/models"
import type { RoleField, SettingValue } from "./settings-value.entity.js"

/**
 * The settings vocabulary every SettingsStore of this package shares: how a
 * config record reads as `EngineSettings`, how a value's string form (what
 * `set` receives: "true", "3", "provider:model") is checked and coerced, and
 * how one key or role changes a settings value.
 */

/** The field each model role is kept under. */
export const ROLE_FIELDS: Readonly<Record<ModelRole, RoleField>> = {
  general: "model",
  code: "codeModel",
  fast: "fastModel",
}

const FIELDS: ReadonlyArray<RoleField | SettingsKey> = ["model", "codeModel", "fastModel", ...SETTINGS_KEYS]

/** One config value, decoded by its key's type: one of another type is none, so it reads as unset. */
const asString = Schema.decodeUnknownOption(Schema.NonEmptyString)
const asNumber = Schema.decodeUnknownOption(Schema.Finite)
const asReasoningEffort = Schema.decodeUnknownOption(ReasoningEffort)

/** Settings from a config record: values of the wrong type read as unset, keys it does not name are not read; the legacy `openAiReasoningEffort` key backs `reasoningEffort`. */
export const settingsFromRecord = (record: Readonly<Record<string, unknown>>): EngineSettings =>
  new EngineSettings({
    model: asString(record["model"]),
    codeModel: asString(record["codeModel"]),
    fastModel: asString(record["fastModel"]),
    fallbackModel: asString(record["fallbackModel"]),
    maxAttempts: asNumber(record["maxAttempts"]),
    budgetMillis: asNumber(record["budgetMillis"]),
    reasoningEffort: Option.orElse(
      asReasoningEffort(record["reasoningEffort"]),
      () => asReasoningEffort(record["openAiReasoningEffort"]),
    ),
    codeReasoningEffort: asReasoningEffort(record["codeReasoningEffort"]),
    fastReasoningEffort: asReasoningEffort(record["fastReasoningEffort"]),
  })

/** Settings as a config record: the set fields only. */
export const recordOfSettings = (settings: EngineSettings): Readonly<Record<string, SettingValue>> =>
  Object.fromEntries(FIELDS.flatMap((field) => Option.match(fieldOf(settings, field), {
    onNone: () => [],
    onSome: (value) => [[field, value] as const],
  })))

const fieldOf = (settings: EngineSettings, field: RoleField | SettingsKey): Option.Option<SettingValue> => settings[field]

const refuse = (message: string) => Effect.fail(new SettingsError({ message }))

/**
 * One key's value from its string form, checked: a selection must be
 * `"<provider>:<modelId>"`, an effort one the models accept, a count a
 * positive integer. A value that does not parse is
 * refused, not written and then ignored on load.
 */
export const coerceSettingValue = (key: SettingsKey, raw: string): Effect.Effect<SettingValue, SettingsError> =>
  Match.value(key).pipe(
    Match.when("fallbackModel", () => Option.match(parseModelSelection(raw), {
      onNone: () => refuse(`fallbackModel must be "<provider>:<modelId>" — got "${raw}"`),
      onSome: () => Effect.succeed<SettingValue>(raw),
    })),
    Match.whenOr("reasoningEffort", "codeReasoningEffort", "fastReasoningEffort", (effort) => Option.match(asReasoningEffort(raw), {
      onNone: () => refuse(`${effort} is not supported: "${raw}"`),
      onSome: (value) => Effect.succeed<SettingValue>(value),
    })),
    // maxAttempts / budgetMillis: positive integers.
    Match.whenOr("maxAttempts", "budgetMillis", (count) => Number.isInteger(Number(raw)) && Number(raw) >= 1
      ? Effect.succeed<SettingValue>(Number(raw))
      : refuse(`${count} must be a positive integer — got "${raw}"`)),
    Match.exhaustive,
  )

/** A role's selection, checked: `None` clears the role; a value must be `"<provider>:<modelId>"`. */
export const roleSelection = (role: ModelRole, selection: Option.Option<string>): Effect.Effect<Option.Option<string>, SettingsError> =>
  Option.match(selection, {
    onNone: () => Effect.succeed(Option.none<string>()),
    onSome: (raw) => Option.isSome(parseModelSelection(raw))
      ? Effect.succeed(Option.some(raw))
      : refuse(`the ${role} model must be "<provider>:<modelId>" — got "${raw}"`),
  })

/** `settings` with one field set, or cleared with `None`. */
const withField = (settings: EngineSettings, field: RoleField | SettingsKey, value: Option.Option<SettingValue>): EngineSettings => {
  const others = Object.fromEntries(Object.entries(recordOfSettings(settings)).filter(([key]) => key !== field))
  return settingsFromRecord(Option.match(value, { onNone: () => others, onSome: (set) => ({ ...others, [field]: set }) }))
}

/** `settings` with one key set from its string form (checked, as `set` takes it), or cleared with `None`. */
export const applySetting = (settings: EngineSettings, key: SettingsKey, value: Option.Option<string>): Effect.Effect<EngineSettings, SettingsError> =>
  Option.match(value, {
    onNone: () => Effect.succeed(withField(settings, key, Option.none())),
    onSome: (raw) => coerceSettingValue(key, raw).pipe(Effect.map((coerced) => withField(settings, key, Option.some(coerced)))),
  })

/** `settings` with one role's selection set (checked, as `setRole` takes it), or cleared with `None`. */
export const applyRole = (settings: EngineSettings, role: ModelRole, selection: Option.Option<string>): Effect.Effect<EngineSettings, SettingsError> =>
  roleSelection(role, selection).pipe(Effect.map((checked) => withField(settings, ROLE_FIELDS[role], checked)))
