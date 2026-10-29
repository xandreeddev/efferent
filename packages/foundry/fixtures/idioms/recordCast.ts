const raw: unknown = { id: "a" }

export const open = raw as Record<string, unknown>
export const loose = raw as Readonly<Record<string, any>>
export const shaped = (raw as { readonly id: string }).id
export const typed = raw as Record<string, string>
export const ids = raw as ReadonlyArray<string>
export const literal = { kind: "a" } as const
export const checked = typeof raw === "object" && raw !== null && "id" in raw ? raw.id : undefined
