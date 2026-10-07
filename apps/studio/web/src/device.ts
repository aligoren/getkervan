/**
 * A short device name from a User-Agent string, like "Chrome 154 · Windows". The string comes
 * from the browser that started a session; it is only shown as text (and in full in a tooltip).
 */
export function deviceName(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device"
  const browser = browserOf(userAgent)
  const os = osOf(userAgent)
  return [browser, os].filter(Boolean).join(" · ") || "Unknown device"
}

function browserOf(ua: string): string | undefined {
  // Order matters: Edge and Opera also say "Chrome"; Chrome also says "Safari".
  const rules: [string, RegExp][] = [
    ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
    ["Opera", /(?:OPR|Opera)\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["Safari", /Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//],
  ]
  for (const [name, pattern] of rules) {
    const match = pattern.exec(ua)
    if (match) return `${name} ${match[1]}`
  }
  if (/^curl\//.test(ua)) return "curl"
  if (/^node\b|undici/i.test(ua)) return "Node.js"
  return undefined
}

function osOf(ua: string): string | undefined {
  if (/Windows/.test(ua)) return "Windows"
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS"
  if (/Android/.test(ua)) return "Android"
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS"
  if (/CrOS/.test(ua)) return "ChromeOS"
  if (/Linux/.test(ua)) return "Linux"
  return undefined
}
