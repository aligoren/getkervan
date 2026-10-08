# Calculator example

The smallest Kervan server written in TypeScript: one tool, `add`, called through an in-memory
client (`createTestClient`, no network). The website shows `src/calculator.ts` unchanged.

```sh
pnpm install && pnpm build
node examples/calculator/src/calculator.ts   # prints: sum: 5
```

To serve the tool instead of calling it, replace the last four lines with `await serve(app)` from
`@kervan/transport/node`.
