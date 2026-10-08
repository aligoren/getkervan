// The avatar's letters: letters and digits only, a whole grapheme each, punctuation skipped.
import { describe, expect, it } from "vitest"
import { initials } from "../src/shell/initials.js"

const as = (displayName: string | null, email = "someone@example.test") =>
  initials({ displayName, email })
const fox = String.fromCodePoint(0x1f98a)
const combiningAcute = String.fromCodePoint(0x301)

describe("avatar initials", () => {
  it("skip punctuation around and inside words", () => {
    expect(as("Deniz (ops)")).toBe("DO")
    expect(as("A. Yılmaz")).toBe("AY")
    expect(as("(Ops) [Team]")).toBe("OT")
    expect(as("— Maya —")).toBe("M")
    expect(as("Ana Maria Costa")).toBe("AM")
  })

  it("keep Turkish letters, CJK and digits", () => {
    expect(as("İlknur Işık")).toBe("İI")
    expect(as("ılgaz öztürk")).toBe("IÖ")
    expect(as("山田 太郎")).toBe("山太")
    expect(as("7th Floor")).toBe("7F")
  })

  it("take a whole grapheme, and skip emoji", () => {
    expect(as(`e${combiningAcute}lise martin`)).toBe(`E${combiningAcute}M`)
    expect(as(`${fox} Fox Mulder`)).toBe("FM")
  })

  it("fall back to the email, then to a generic sign", () => {
    expect(as(null, "kerem.aydin@example.test")).toBe("KA")
    expect(as("  ", "ana@example.test")).toBe("A")
    expect(as(`(${fox})`, "ops@example.test")).toBe("O")
    expect(as("...", "--@example.test")).toBe("?")
  })
})
