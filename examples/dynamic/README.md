# Dynamic tools example

- `src/app.ts`: `create_counter` registers a new `counter_<name>` tool at runtime and
  `delete_counter` removes it. Connected clients receive `notifications/tools/list_changed`.
- `src/multi-tenant.ts`: an HTTP server where each API key belongs to a tenant, and each tenant has
  its own tool set. The tenant comes from the verified key (`authenticate`), and `resolveServer`
  maps it to that tenant's registry. After 5 seconds a tool is added to the `acme` tenant only.

```sh
pnpm build
node examples/dynamic/dist/index.js            # stdio
node examples/dynamic/dist/multi-tenant.js     # http://127.0.0.1:3000/mcp, header x-api-key: demo-key-acme
```

The API keys in `multi-tenant.ts` are demo values. Do not reuse them.
