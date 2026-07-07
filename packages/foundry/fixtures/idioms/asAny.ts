export const laundered = (value: string): number => value as unknown as number

export const anyCast = (value: string): string => (value as any).toUpperCase()
