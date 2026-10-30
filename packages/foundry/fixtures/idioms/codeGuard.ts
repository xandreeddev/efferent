import { Option, Predicate } from "effect"

export const missing = (error: unknown): boolean => Predicate.hasProperty(error, "code") && error.code === "ENOENT"
export const coded = Predicate.hasProperty("code")
export const busy = (error: object): boolean => "code" in error && error.code === "SQLITE_BUSY"
/** The one reader, as core's `errorCodeOf`: what it does is not a guard by hand. */
export const errorCodeOf = (error: unknown): Option.Option<string> =>
  Predicate.isObject(error) ? Option.filter(Option.some(error["code"]), Predicate.isString) : Option.none()
export const absent = (error: unknown): boolean => Option.contains(errorCodeOf(error), "ENOENT")
export const named = (error: unknown): boolean => Predicate.hasProperty(error, "name") || (Predicate.isObject(error) && "message" in error)
