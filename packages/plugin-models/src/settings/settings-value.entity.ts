import { Schema } from "effect"

/** A settings value as a config file holds it: a selection or other text, a switch, a count. */
export const SettingValue = Schema.Union([Schema.String, Schema.Boolean, Schema.Number])
export type SettingValue = typeof SettingValue.Type

/** The settings field each model role is kept under. */
export const RoleField = Schema.Literals(["model", "codeModel", "fastModel"])
export type RoleField = typeof RoleField.Type
