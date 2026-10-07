// Times as people read them: "5 minutes ago" for recent activity, "Oct 7, 2026" for dates.
// The exact time is always one hover away (the title) and in the markup (`<time dateTime>`).

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
]

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago" in the viewer's language. */
export function ago(time: number, now = Date.now()): string {
  const diff = time - now
  if (Math.abs(diff) < 45_000) return "just now"
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return format.format(Math.round(diff / size), unit)
  }
  return format.format(Math.round(diff / 60_000), "minute")
}

/** "Oct 7, 2026" in the viewer's locale. */
export function shortDate(time: number): string {
  return new Date(time).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/** A relative time with the exact one in its title, or `never` when there is none. */
export function Ago(props: { time: number | null | undefined; never?: string }) {
  if (typeof props.time !== "number") return <>{props.never ?? "never"}</>
  const date = new Date(props.time)
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {ago(props.time)}
    </time>
  )
}

/** A date with the exact time in its title. */
export function DateOnly(props: { time: number | null | undefined }) {
  if (typeof props.time !== "number") return <>—</>
  const date = new Date(props.time)
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {shortDate(props.time)}
    </time>
  )
}
