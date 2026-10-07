// Every date, time and relative time in the UI is formatted here, in English: the UI is English,
// so "Oct 7, 2026" and "3 minutes ago" must not turn into "7 Eki 2026" or "3 dakika önce" because
// of the browser's language. Nothing else calls toLocale*String or Intl's formatters (a test
// checks that).

/** The UI's language for dates and times, whatever the browser's. */
export const LOCALE = "en-US"

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
]

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" })
const dateFormat = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
})
const shortFormat = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})
const fullFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "long" })

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function ago(time: number, now = Date.now()): string {
  const diff = time - now
  if (Math.abs(diff) < 45_000) return "just now"
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit)
  }
  return relative.format(Math.round(diff / 60_000), "minute")
}

/** "Oct 7, 2026". */
export function shortDate(time: number): string {
  return dateFormat.format(time)
}

/** "Oct 7, 02:41:17 PM": for tables of events (calls, the audit log, versions, secrets). */
export function shortTime(time: number): string {
  return shortFormat.format(time)
}

/** "Oct 7, 2026, 2:41:17 PM GMT+3": the exact time, for titles. */
export function fullTime(time: number): string {
  return fullFormat.format(time)
}

/** A relative time with the exact one in its title, or `never` when there is none. */
export function Ago(props: { time: number | null | undefined; never?: string }) {
  if (typeof props.time !== "number") return <>{props.never ?? "never"}</>
  return (
    <time dateTime={new Date(props.time).toISOString()} title={fullTime(props.time)}>
      {ago(props.time)}
    </time>
  )
}

/** A date with the exact time in its title. */
export function DateOnly(props: { time: number | null | undefined }) {
  if (typeof props.time !== "number") return <>—</>
  return (
    <time dateTime={new Date(props.time).toISOString()} title={fullTime(props.time)}>
      {shortDate(props.time)}
    </time>
  )
}
