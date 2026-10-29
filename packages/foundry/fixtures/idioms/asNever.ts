const value: unknown = 1
export const a = value as never
export const b = String(value)
export const c = (value as never) as string
