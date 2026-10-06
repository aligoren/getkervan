import { createTestClient } from "@kervan/transport/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { app } from "../src/app.js"

const json = (body: unknown) => Response.json(body)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("weather example", () => {
  it("adds numbers", async () => {
    const client = await createTestClient(app)
    const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } })
    expect(result.structuredContent).toEqual({ sum: 5 })
    await client.close()
  })

  it("returns selected weather fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.hostname.startsWith("geocoding")
          ? json({
              results: [{ name: "Istanbul", country: "Türkiye", latitude: 41, longitude: 29 }],
            })
          : json({
              current: { temperature_2m: 18, wind_speed_10m: 10, weather_code: 3 },
              extra: "ignored",
            }),
      ),
    )
    const client = await createTestClient(app)
    const result = await client.callTool({ name: "get_weather", arguments: { city: "Istanbul" } })
    expect(result.structuredContent).toEqual({
      city: "Istanbul",
      country: "Türkiye",
      temperatureC: 18,
      windKmh: 10,
      weatherCode: 3,
    })
    await client.close()
  })

  it("explains unknown cities to the model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({})),
    )
    const client = await createTestClient(app)
    const result = await client.callTool({ name: "get_weather", arguments: { city: "Atlantis" } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: "text",
        text: 'No city found for "Atlantis". Check the spelling or try a larger city.',
      },
    ])
    await client.close()
  })

  it("reports countdown progress", async () => {
    const client = await createTestClient(app)
    const progress: number[] = []
    const result = await client.callTool(
      { name: "countdown", arguments: { n: 3 } },
      { onprogress: ({ progress: value }) => progress.push(value) },
    )
    expect(progress).toEqual([1, 2, 3])
    expect(result.content).toEqual([{ type: "text", text: "Liftoff!" }])
    await client.close()
  })
})
