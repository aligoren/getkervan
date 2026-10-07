/**
 * The spec a new server starts with: a working example against the public Open-Meteo API (no
 * key, no secrets), so a first save is valid and the playground has something to call. A test
 * loads it with the spec runtime.
 */
export const STARTER_SPEC = `specVersion: 1
name: weather
version: 0.1.0
description: Weather forecasts from the public Open-Meteo API.
tools:
  - name: get_daily_forecast
    title: Daily forecast
    description: Minimum and maximum temperature for the next 3 days at a coordinate, in the place's own time zone.
    annotations: { readOnlyHint: true }
    input:
      type: object
      properties:
        latitude: { type: number, minimum: -90, maximum: 90 }
        longitude: { type: number, minimum: -180, maximum: 180 }
      required: [latitude, longitude]
    http:
      url: https://api.open-meteo.com/v1/forecast
      query:
        latitude: "{{input.latitude}}"
        longitude: "{{input.longitude}}"
        daily: temperature_2m_min,temperature_2m_max
        forecast_days: 3
        # Dates and times in the location's own time zone.
        timezone: auto
    output:
      select: "{timezone: timezone, days: daily.time, minC: daily.temperature_2m_min, maxC: daily.temperature_2m_max}"
`
