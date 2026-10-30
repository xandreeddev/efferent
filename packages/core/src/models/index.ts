// `@xandreed/core/models`: the models plugin's storage, the credential and
// settings stores and their kits. Imported by `@xandreed/plugin-models` only.
export { AuthError, AuthStore, Credential } from "../ports/auth-store.port.js"
export { EngineSettings, SETTINGS_KEYS, SettingsError, SettingsStore } from "../ports/settings-store.port.js"
export type { ModelRole, SettingsKey } from "../ports/settings-store.port.js"
export { authStoreConformance } from "./auth-store.conformance.js"
export type { AuthStoreConformanceOptions, AuthStoreRefreshProbe } from "./auth-store.conformance.js"
export { settingsStoreConformance } from "./settings-store.conformance.js"
export type { SettingsStoreConformanceOptions } from "./settings-store.conformance.js"
