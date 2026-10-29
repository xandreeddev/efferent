import type { StoreFailure } from "./errorCode.js"

export const retries = (error: StoreFailure): boolean => error.code === "busy"
export const settled = (error: StoreFailure): boolean => "gone" !== error.code
export const missing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
export const local = (value: { readonly code: string }): boolean => value.code === "local"
