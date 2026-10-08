---
title: Secrets and environment variables
seoTitle: 'Secrets in kervan.yaml: API keys and env files'
description: How a kervan.yaml spec uses API keys and other secrets from environment variables, binds them to hosts, and keeps them out of results, errors and logs.
lead: A spec names the secrets it needs; the values come from the environment and never appear in what the server returns or logs.
weight: 40
group: Build with YAML
fits: 'Build with YAML. The last page of the group; then [run it](/docs/framework/transports/).'
next:
  - url: /docs/framework/transports/
    text: 'Transports and authentication'
    note: 'serve the spec'
  - url: /docs/framework/security/
    text: 'Security model'
---

## Declaring and using a secret

```yaml {check="spec"}
specVersion: 1
name: weather
version: 0.1.0
secrets: [OPENWEATHER_KEY]
tools:
  - name: get_current_weather
    description: Current temperature and wind for a coordinate.
    annotations: { readOnlyHint: true }
    input:
      type: object
      properties: { lat: { type: number }, lon: { type: number } }
      required: [lat, lon]
    http:
      url: https://api.openweathermap.org/data/2.5/weather
      query: { lat: "{{input.lat}}", lon: "{{input.lon}}", appid: "{{secrets.OPENWEATHER_KEY}}" }
    output:
      select: "{temperature: main.temp, wind: wind.speed}"
```

Only declared names resolve. With `kervan run`, values come from environment variables of the same
name, or from env files:

```sh {check="manual" reason="needs a real OpenWeather API key; the spec loads in the docs check"}
OPENWEATHER_KEY=... node packages/cli/bin/kervan.js run weather.yaml
node packages/cli/bin/kervan.js run weather.yaml --env-file .env
```

In PowerShell, set the variable first: `$env:OPENWEATHER_KEY = "..."`. Variables already set win
over the file. Node.js itself checks `--env-file` paths and exits with `<file>: not found` (code 9)
when the file is missing.

## Redaction

{{% include file="packages/spec-runtime/README.md" section="Secrets" until="Binding a secret to hosts" %}}

## Binding a secret to hosts

{{% include file="packages/spec-runtime/README.md" section="Binding a secret to hosts" %}}

## In code

`loadSpec(text, { secrets })` takes any `SecretSource`, an object with
`get(name, { host, tool })`. `envSecrets()` is the default. See the
[programmatic API](/docs/framework/api/).
