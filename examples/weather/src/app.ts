import { createApp, ToolError, z } from "@kervan/core"

export const app = createApp({ name: "kervan-weather", version: "0.1.0" })

const Place = z.object({
  name: z.string(),
  country: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
})

const Forecast = z.object({
  current: z.object({
    temperature_2m: z.number(),
    wind_speed_10m: z.number(),
    weather_code: z.number(),
  }),
})

/** Fetches JSON with its own timeout on top of the tool's cancellation signal. */
async function getJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  })
  if (!response.ok) {
    throw new ToolError(`The weather service answered ${response.status}. Try again later.`)
  }
  return response.json()
}

app.tool("get_weather", {
  title: "Current weather",
  description: "Current temperature, wind speed and WMO weather code for a city, from Open-Meteo.",
  input: z.object({ city: z.string().min(1).max(100).describe("City name, e.g. Istanbul") }),
  output: z.object({
    city: z.string(),
    country: z.string().optional(),
    temperatureC: z.number(),
    windKmh: z.number(),
    weatherCode: z.number().describe("WMO weather interpretation code"),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ city }, ctx) => {
    const search = new URL("https://geocoding-api.open-meteo.com/v1/search")
    search.searchParams.set("name", city)
    search.searchParams.set("count", "1")
    const geo = z
      .object({ results: z.array(Place).optional() })
      .parse(await getJson(search, ctx.signal))
    const place = geo.results?.[0]
    if (!place) {
      throw new ToolError(`No city found for "${city}". Check the spelling or try a larger city.`)
    }

    const forecast = new URL("https://api.open-meteo.com/v1/forecast")
    forecast.searchParams.set("latitude", String(place.latitude))
    forecast.searchParams.set("longitude", String(place.longitude))
    forecast.searchParams.set("current", "temperature_2m,wind_speed_10m,weather_code")
    const { current } = Forecast.parse(await getJson(forecast, ctx.signal))

    // Return only selected fields: external API output is untrusted input for the model.
    return {
      city: place.name,
      ...(place.country === undefined ? {} : { country: place.country }),
      temperatureC: current.temperature_2m,
      windKmh: current.wind_speed_10m,
      weatherCode: current.weather_code,
    }
  },
})

app.tool("add", {
  description: "Adds two numbers. Handy for checking that the server is connected.",
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ a, b }) => ({ sum: a + b }),
})

app.tool("countdown", {
  description:
    "Counts down from n to zero, reporting progress. Demonstrates ctx.progress and ctx.log.",
  input: z.object({ n: z.number().int().min(1).max(10) }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ n }, ctx) => {
    for (let i = 1; i <= n; i++) {
      ctx.signal.throwIfAborted()
      await new Promise((resolve) => setTimeout(resolve, 100))
      await ctx.progress(i, n, `${n - i} left`)
      ctx.log.debug("tick", { remaining: n - i })
    }
    return "Liftoff!"
  },
})
