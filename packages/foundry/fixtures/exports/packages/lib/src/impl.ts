export const used = 1
export const viaNamespace = 2
export const viaReexport = 3
export const scripted = 4
export const documented = 5
export const selfOnly = 6
export const changelogged = 7
export const fenced = 8
export const unused = 9
export const hostApi = 10
export const taggedHere = 11
/** @deprecated import `used` instead */
export const deprecatedAtSource = 12
/** @deprecated nothing replaces it */
export const retired = 13
export type ViaType = string
