type Shape =
  | { readonly _tag: "circle"; readonly r: number }
  | { readonly _tag: "square"; readonly s: number }

export const area = (shape: Shape): number => {
  switch (shape._tag) {
    case "circle":
      return Math.PI * shape.r * shape.r
    case "square":
      return shape.s * shape.s
  }
}

export const label = (shape: Shape): string => {
  if (shape._tag === "circle") {
    return "circle"
  } else if (shape._tag === "square") {
    return "square"
  }
  return "unknown"
}

export const isCircle = (shape: Shape): boolean => shape._tag === "circle"
