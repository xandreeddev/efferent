import { Array as Arr, Order } from "effect"

export const bare = (xs: Array<number>) => xs.sort()
export const copied = (xs: ReadonlyArray<number>) => xs.toSorted()
export const ordered = (xs: ReadonlyArray<number>) => Arr.sort(xs, Order.Number)
export const compared = (xs: Array<number>) => xs.sort((a, b) => a - b)
