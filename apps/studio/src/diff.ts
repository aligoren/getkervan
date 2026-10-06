export interface DiffLine {
  kind: "same" | "added" | "removed"
  text: string
}

/** Above this many line pairs, `diffLines` gives up instead of using quadratic memory. */
export const MAX_DIFF_CELLS = 4_000_000

/**
 * A line diff of two texts (longest common subsequence), or `undefined` when the texts are too
 * large to compare cheaply. Common leading and trailing lines are matched first.
 */
export function diffLines(before: string, after: string): DiffLine[] | undefined {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length * midB.length > MAX_DIFF_CELLS) return undefined

  // lengths[i][j] = LCS length of midA[i..] and midB[j..], in one flat array.
  const width = midB.length + 1
  const lengths = new Uint32Array((midA.length + 1) * width)
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        midA[i] === midB[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0)
    }
  }

  const lines: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }))
  let i = 0
  let j = 0
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      lines.push({ kind: "same", text: midA[i] ?? "" })
      i++
      j++
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      lines.push({ kind: "removed", text: midA[i] ?? "" })
      i++
    } else {
      lines.push({ kind: "added", text: midB[j] ?? "" })
      j++
    }
  }
  for (; i < midA.length; i++) lines.push({ kind: "removed", text: midA[i] ?? "" })
  for (; j < midB.length; j++) lines.push({ kind: "added", text: midB[j] ?? "" })
  for (const text of a.slice(endA)) lines.push({ kind: "same", text })
  return lines
}
