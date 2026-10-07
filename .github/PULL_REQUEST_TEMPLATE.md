## What and why

<!-- What does this change, and why? Link the issue it closes, if any ("Closes #123"). -->

## How it was tested

<!-- The tests you added or changed, and what you ran. -->

- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] `pnpm check:pack` passes (if a package's files or exports changed)
- [ ] `pnpm e2e` passes (if Studio's web UI changed)

## Security

<!-- Leave the boxes that do not apply unchecked and say why in a line. -->

- [ ] A new security check has a test that fails when the check is removed (see CONTRIBUTING.md,
      "Security tests")
- [ ] No secret, token, key or password in code, tests, fixtures, logs or screenshots (only
      made-up test values)
- [ ] User-supplied text that reaches a new surface is listed in `docs/TEXT-SURFACES.md`
- [ ] `docs/THREAT-MODEL-STUDIO.md` is updated if Studio's guarantees changed

**Found a vulnerability?** Do not describe it in a pull request: report it privately (see
SECURITY.md).

## Public API

- [ ] No change to the public API, or `docs/API.md` and `test/api.test.ts` are updated
