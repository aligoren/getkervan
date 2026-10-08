# Releasing Kervan

Nothing is published yet: no repository, no npm packages, no image. This page is the checklist for
the first release, how a release runs, how to undo a bad one, and the decisions still open.

The workflows in `.github/workflows/` are written but have not run: CI (`ci.yml`) starts once the
repository exists; the weekly site check (`site-check.yml`) on its schedule; publishing
(`release.yml`) only by hand, after an approval, and only when the guard allows it.

## First release: what the maintainer does

These need an account, a payment method, a legal decision or a person's approval; Claude Code
cannot do them.

**GitHub**

- [ ] Create the GitHub organization and the repository (public). Push `main`.
- [ ] Enable **private vulnerability reporting** (Settings, Security). SECURITY.md sends reporters
      there.
- [ ] Protect `main`: pull requests required, the CI checks required (each `test (...)` job and
      `e2e`), no force pushes, no deletion. Optionally signed commits.
- [ ] Create the **`release` environment** with required reviewers (at least one person approves
      every publish). Restrict it to `main`.
- [ ] Enable **Dependabot alerts** and **Dependabot security updates**; version updates come from
      `.github/dependabot.yml`. Check that Dependabot reads the pnpm lockfile: if it does not
      support this pnpm version yet, version updates for npm stay quiet (security alerts still
      work).
- [ ] Enable **secret scanning** and **push protection**.
- [ ] Fill in the owners in `.github/CODEOWNERS` and the repository path in
      `.github/ISSUE_TEMPLATE/config.yml` (both marked TODO).
- [ ] Settings, Actions: allow only actions pinned to a full commit SHA (the workflows already
      are), and set the default workflow permissions to read-only.

**npm**

- [ ] Create the **`@kervan` organization** on npm. The unscoped names `kervan` and
      `create-kervan` must be free and registered by the same account.
- [ ] **Two-factor authentication** for every maintainer, and "Require two-factor authentication"
      on the organization.
- [ ] For each package (`@kervan/core`, `@kervan/transport`, `@kervan/spec-runtime`, `kervan`,
      `create-kervan`), add a **trusted publisher**: this repository and the workflow
      `release.yml`, environment `release`. Then no npm token exists anywhere; provenance is
      attached automatically. (The first publish of a new name may need a token once, if npm does
      not allow a trusted publisher on a name that does not exist yet: create a granular token
      limited to these packages, use it once, and revoke it.)
- [ ] After the first release: in each package's npm settings, "Require two-factor authentication
      and disallow tokens".

**The repository's content**

- [ ] Add `repository`, `bugs` and `homepage` to every `package.json` (provenance needs
      `repository` to match the GitHub repository).
- [ ] Remove the "**Not published yet.**" notes from the five package READMEs (`packages/*/README.md`)
      and the "before the packages are published" parts of the root README (`pnpm try:new`).
      `guard-publish` refuses to publish while a note is there.
- [ ] The website: add the repository link (`site/index.html`, "Source code") and deploy it
      (`docs/DEPLOY-SITE.md`).
- [ ] Once the site is live, add `# yaml-language-server: $schema=https://getkervan.dev/schema/v1.json`
      to the generated project, the examples and Studio's starter spec.
- [ ] Mailboxes: `security@`, `hello@` and `conduct@getkervan.dev` must reach a person.
- [ ] Decide the version (see Open decisions) and set it in every `package.json`.
- [ ] Read [`docs/REVIEW-NOTES.md`](REVIEW-NOTES.md): the security reviews' unproven suspicions
      and the accepted risks. Decide for each **open** item whether it waits or blocks the release.
- [ ] Set the variable `KERVAN_ALLOW_PUBLISH` to `1` on the `release` environment, only when
      ready to publish (and back to empty afterwards, if you like the extra step).

## What Claude Code can do

- Prepare the content changes above as a pull request: the `repository`/`bugs`/`homepage` fields,
  removing the "Not published yet" notes, the site link and `yaml-language-server` lines, the
  version bump, CODEOWNERS and the issue template link once the names are known.
- Run the whole check chain locally, clean clones on Node 22 and 24 and on Linux in Docker, and
  `pnpm try:new` against locally packed tarballs, and report the results.
- Dry runs: `pnpm -r --filter "./packages/*" pack` and inspect the tarballs; publishing to a local
  registry (Verdaccio) and installing from it, as before 0.1.
- Write release notes from the git history.
- It does not create accounts, change repository or npm settings, approve the `release`
  environment, or publish.

## How a release runs

1. Before every release, check [`docs/REVIEW-NOTES.md`](REVIEW-NOTES.md) for open items that
   should be done first, and update it with anything new.
2. A pull request bumps the versions and updates the release notes; CI is green; it is merged.
3. Actions, **Release**, Run workflow on `main`, choose the dist-tag (`next` for a pre-release,
   `latest` for a release).
4. A reviewer approves the `release` environment.
5. The workflow runs the whole chain again, packs the packages, runs the guard for each of them,
   and publishes them in dependency order with provenance.
6. Check: `npm view @kervan/core dist-tags`, the provenance badge on npmjs.com, and a fresh
   `npm create kervan@<version> my-server` on a clean machine.
7. Tag the commit (`v0.1.0`) and publish the GitHub release with the notes.

## When a release goes wrong

- **A broken release** (it installs but misbehaves): publish a fixed patch version. Mark the bad
  one: `npm deprecate @kervan/core@0.1.1 "Broken: use 0.1.2"` (for each affected package). Move
  `latest` back if needed: `npm dist-tag add @kervan/core@0.1.0 latest`.
- **Published by mistake** (wrong content, or before it was meant to be): within 72 hours, and
  while nothing depends on it, `npm unpublish @kervan/core@0.1.1` is possible; that version
  number can never be used again. After that, deprecate it and publish a corrected version.
- **A secret or private file in a tarball:** treat the secret as leaked whatever you do next:
  revoke and rotate it first. Then unpublish if npm still allows it (and contact npm support),
  otherwise deprecate, and publish a clean version. Find out why `check:pack` did not catch it and
  add a check.
- **A security fix:** follow SECURITY.md: a private GitHub security advisory, a fixed release,
  then publish the advisory (with a CVE) so `npm audit` warns users. Deprecate the affected
  versions with a pointer to the advisory.
- **A compromised maintainer account or workflow:** revoke tokens and sessions, check the npm
  packages' versions and provenance (each must come from `release.yml` on this repository),
  deprecate anything not built by the workflow, and tell users in an advisory.

## Open decisions

### a) The first version: 0.1.0, or a pre-release first?

- **0.1.0 directly** under `latest`. Simple; 0.x already says the API may change.
- **A pre-release first** (`0.1.0-rc.1` under `next`), then `0.1.0` under `latest` a week or two
  later. It checks the real publishing path (trusted publishing, provenance, `npm create kervan`
  from the registry, Dependabot and installers) while only people who ask for `next` get it.

Recommendation: a pre-release first. The first publish of five packages through a new workflow
is where mistakes happen, and a pre-release under `next` is cheap to replace.

### b) How Studio is distributed

Studio is `private` and is not on npm. Options:

1. **From source only** (clone, `pnpm install`, `pnpm build`, run `apps/studio/bin`). Nothing
   new to maintain; harder for operators.
2. **A Docker image** (for example `ghcr.io/<org>/kervan-studio`), built and signed by a workflow
   with provenance. Easiest to run; one more artifact to keep patched.
3. **An npm package** (`@kervan/studio`). Possible, but Studio is an application with a native
   dependency (better-sqlite3), not a library.

Recommendation: from source for 0.1; a Docker image after it (the first-admin step below now
works in a container).

**Setting up in a container.** Until the first admin exists, Studio listens on 127.0.0.1 only
(T9 in the threat model). Inside a container, that is the container's own loopback: a published
port does not reach it, so the setup page cannot be opened from outside. The operator creates
the first admin with `kervan-studio create-admin` through `docker exec` instead; the network
never offers setup. The running Studio notices the admin within a few seconds and starts
listening on `KERVAN_STUDIO_HOST` (no restart).

```sh
# With a terminal: asks for the password twice, hidden.
docker exec -it kervan-studio node apps/studio/bin/kervan-studio.js create-admin --email admin@example.com

# Without one (automation): the password from a file, on stdin; never as an argument.
docker exec -i kervan-studio node apps/studio/bin/kervan-studio.js create-admin \
  --email admin@example.com --password-stdin < /root/first-admin-password.txt
```

`docker exec` runs with the container's environment, so the command finds the same
`KERVAN_STUDIO_DATA_DIR` and `KERVAN_STUDIO_MASTER_KEY` as Studio. It is refused once any admin
exists (`reset-admin` recovers an admin). The other ways in, for the record: a first start with
`--network host` (Linux) and the setup page through an SSH tunnel (awkward), or an opt-in setting
that offers setup on the configured interface (weakens T9; not built).

**A Dockerfile draft.** Not in the repository's build or workflows. It was built and run locally
to check it (healthy within seconds, as the `node` user, with a read-only root file system), and
the first admin was created with `create-admin` through `docker exec` as above; nothing was
pushed. Before use: pin the base image by digest.

```dockerfile
# syntax=docker/dockerfile:1
# Kervan Studio: a DRAFT (see docs/RELEASING.md).
# TODO(release): pin both base images by digest (node:24-bookworm-slim@sha256:...) and let
# Dependabot's docker ecosystem update them.

# 1. Build everything (TypeScript and the web UI).
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# 2. Production dependencies of Studio and the workspace packages it uses, nothing else.
FROM node:24-bookworm-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/transport/package.json packages/transport/
COPY packages/spec-runtime/package.json packages/spec-runtime/
COPY apps/studio/package.json apps/studio/
RUN pnpm install --prod --frozen-lockfile --filter "@kervan/studio..."

# 3. What runs: no compilers, no package manager, not root.
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    KERVAN_STUDIO_HOST=0.0.0.0 \
    KERVAN_STUDIO_PORT=4310 \
    KERVAN_STUDIO_DATA_DIR=/data
WORKDIR /app
COPY --from=deps /src/node_modules node_modules
COPY --from=deps /src/packages/core/node_modules packages/core/node_modules
COPY --from=deps /src/packages/transport/node_modules packages/transport/node_modules
COPY --from=deps /src/packages/spec-runtime/node_modules packages/spec-runtime/node_modules
COPY --from=deps /src/apps/studio/node_modules apps/studio/node_modules
COPY --from=build /src/packages/core/package.json /src/packages/core/LICENSE packages/core/
COPY --from=build /src/packages/core/dist packages/core/dist
COPY --from=build /src/packages/transport/package.json /src/packages/transport/LICENSE packages/transport/
COPY --from=build /src/packages/transport/dist packages/transport/dist
COPY --from=build /src/packages/spec-runtime/package.json /src/packages/spec-runtime/LICENSE packages/spec-runtime/
COPY --from=build /src/packages/spec-runtime/dist packages/spec-runtime/dist
COPY --from=build /src/packages/spec-runtime/schema packages/spec-runtime/schema
COPY --from=build /src/apps/studio/package.json apps/studio/
COPY --from=build /src/apps/studio/bin apps/studio/bin
COPY --from=build /src/apps/studio/dist apps/studio/dist
COPY --from=build /src/apps/studio/dist-web apps/studio/dist-web
COPY --from=build /src/apps/studio/drizzle apps/studio/drizzle
COPY --from=build /src/LICENSE ./

# The database lives in a volume owned by the unprivileged `node` user (uid 1000).
RUN mkdir /data && chown node:node /data && chmod 700 /data
VOLUME /data
USER node
EXPOSE 4310

# Asks Studio itself, with the Host header it accepts (its public URL's host).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const u=new URL(process.env.KERVAN_STUDIO_PUBLIC_URL||'http://127.0.0.1:4310');require('node:http').get({host:'127.0.0.1',port:process.env.KERVAN_STUDIO_PORT,path:'/api/setup',headers:{host:u.host}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

ENTRYPOINT ["node", "apps/studio/bin/kervan-studio.js"]
CMD ["start"]
```

Running it (behind a TLS-terminating reverse proxy; the master key comes from a secret store,
never from the command line in shell history):

```sh
docker run -d --name kervan-studio \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  -v kervan-studio-data:/data \
  -p 127.0.0.1:4310:4310 \
  -e KERVAN_STUDIO_PUBLIC_URL=https://studio.example.com \
  -e KERVAN_STUDIO_TRUST_PROXY=1 \
  --env-file /etc/kervan-studio/secrets.env \
  kervan-studio:<version>
```

- `secrets.env` (mode 0600, owned by root) holds `KERVAN_STUDIO_MASTER_KEY`. Back up the key and
  the volume separately (apps/studio/README.md, "Data and backups").
- The read-only root works: Studio writes only to `/data`, and `select` processes write nothing.
- A `.dockerignore` (`node_modules`, `.kervan-studio`, `dist`, `.git`) belongs next to the
  Dockerfile when it moves into the repository.
