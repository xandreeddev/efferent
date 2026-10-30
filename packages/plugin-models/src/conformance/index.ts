// `@xandreed/plugin-models/conformance`: the kits of the credential and
// settings stores, run against each adapter of the `AuthStore` and
// `SettingsStore` ports (the root exports the ports) under any test runner.
export { authStoreConformance } from "../auth/auth-store.conformance.js"
export type { AuthStoreConformanceOptions, AuthStoreRefreshProbe } from "../auth/auth-store.conformance.js"
export { settingsStoreConformance } from "../settings/settings-store.conformance.js"
export type { SettingsStoreConformanceOptions } from "../settings/settings-store.conformance.js"
