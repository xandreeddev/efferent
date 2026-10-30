export {
  used,
  viaNamespace,
  viaReexport,
  scripted,
  documented,
  selfOnly,
  changelogged,
  fenced,
  unused,
  deprecatedAtSource,
  retired,
  type ViaType,
} from "./impl.js"
/** @public documented host API */
export { hostApi } from "./impl.js"
export { /** @public */ taggedHere } from "./impl.js"
export * from "./impl.js"
export * as everything from "./impl.js"
export const localUnused = 1
/** @public */
export const localPublic = 2
export interface Shape {
  readonly id: string
}
export type Alias = string
/** @deprecated import `used` instead */
export const oldName = 3
export default function main(): void {}
