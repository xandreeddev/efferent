export const tagAndCode = (error: { readonly _tag: string }) => [error._tag, "code" in error ? error.code : null]
