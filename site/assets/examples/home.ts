import { createApp, z } from "@kervan/core"
import { serve } from "@kervan/transport/node"

const app = createApp({ name: "weather", version: "0.1.0" })
app.tool("get_current_weather", {
  description: "Current temperature (°C) and wind speed (km/h) at a latitude and longitude.",
  input: z.object({ lat: z.number(), lon: z.number() }),
  handler: async ({ lat, lon }) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m`
    return JSON.stringify((await (await fetch(url)).json()).current)
  },
})

await serve(app)
