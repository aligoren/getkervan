/** Joins class names, skipping empty ones (`cn("a", cond && "b")`). */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ")
}
