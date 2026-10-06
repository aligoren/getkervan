# Spec example

`kervan.yaml` defines two tools backed by the public [Open-Meteo](https://open-meteo.com) APIs,
without writing code.

```sh
pnpm build
node packages/cli/bin/kervan.js run examples/spec/kervan.yaml          # stdio
node packages/cli/bin/kervan.js run examples/spec/kervan.yaml --http   # http://127.0.0.1:3000/mcp
node packages/cli/bin/kervan.js dev examples/spec/kervan.yaml          # reloads on save
```

Secrets go in environment variables or an env file passed with `--env-file .env`; `.env` is
ignored by git (see `.env.example`).
