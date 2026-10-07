# Contributing to Kervan

Thank you for helping. This page covers setting up, the checks every change passes, and what
security-related changes need. By taking part you agree to the
[code of conduct](CODE_OF_CONDUCT.md).

**Security problems are not reported here:** do not open an issue or a pull request for them.
See [SECURITY.md](SECURITY.md).

## Setting up

You need Node.js 22.18+ (or 24; on Windows, 24.21 or later) and pnpm, which corepack provides at
the version in `package.json`:

```sh
corepack enable
pnpm install
pnpm build
```

The repository is a pnpm workspace:

- `packages/core`, `packages/transport`, `packages/spec-runtime`, `packages/cli` (the `kervan`
  command) and `packages/create-kervan`: the framework, published to npm;
- `apps/studio`: Kervan Studio (Hono server and React UI), not published;
- `examples/`, `site/` (the website) and `docs/`.

The framework never depends on Studio: Studio uses only the packages' public API (a lint rule and
a test check this).

## The check chain

Every change passes all of these (CI runs them on Linux and Windows, Node 22 and 24):

```sh
pnpm build
pnpm lint         # Biome: formatting and lint rules (`pnpm exec biome check --write .` fixes most)
pnpm typecheck
pnpm test         # Vitest: unit, integration (real MCP clients, real HTTP) and review tests
pnpm check:pack   # what the npm packages contain, and their types
pnpm check:site   # the website's dates and schema copy
pnpm e2e          # Studio in a browser (Playwright; needs Chromium) when the UI changes
```

## Writing changes

- Code, comments, docs and commit messages are in English. Keep comments short and about why.
- Small, readable, tested code; no abstraction before it is needed.
- Every behavior change comes with a test. Integration tests use the official MCP SDK client, in
  memory, over stdio or over real HTTP.
- The public API is listed in [`docs/API.md`](docs/API.md) and pinned by `test/api.test.ts`:
  changing that list is an API change, so say so in the pull request.
- Text a user types that others will see (names, spec text, messages) must not hide anything:
  see [`docs/TEXT-SURFACES.md`](docs/TEXT-SURFACES.md) and add new fields or surfaces there.
- Never put a real secret, API key, token or password anywhere: code, tests, fixtures, logs,
  screenshots. Tests use obviously made-up values.

## Security tests

Security checks (SSRF rules, secret redaction, authentication, CSRF and origin checks, limits) are
held to a higher bar:

1. **A test that fails without the check.** A test that passes whether or not the check is there
   proves nothing. Before you open the pull request, remove or weaken the check by hand (for
   example, turn its condition into `false`), run the test, and see it fail. Say in the pull
   request which test catches it. This is the project's mutation testing; reviewers may repeat
   it.
2. **Every layer on its own.** When a rule is enforced in two places (say, a request check and a
   load check), each needs a test that fails when only that one is removed.
3. **Use what an attacker would send.** Real requests with the headers, encodings and timing an
   attack would use (the review tests in `test/review/` folders show the style), not only the
   happy path.
4. **Update the threat model** ([`docs/THREAT-MODEL-STUDIO.md`](docs/THREAT-MODEL-STUDIO.md))
   when Studio's guarantees change.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make the change with its tests; run the check chain.
3. Open a pull request and fill in the template. Keep it to one topic; a large change is easier
   to review as several pull requests.
4. A maintainer reviews it. CI must be green before it is merged.

Dependency updates come from Dependabot. When you add a dependency, say why, prefer small and
well-maintained packages, and do not add a release younger than a week.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
