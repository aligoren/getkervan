# Releasing Kervan

Nothing is published yet: no public repository, no npm packages, no image. The first release is
**`0.1.0-rc.1` under the npm dist-tag `next`**; `0.1.0` under `latest` follows a week or two later
(decision a below). This page is the order of that first release, how a release runs, how to undo
a bad one, and the decisions still open.

Lines marked **Verify on release day** come from npm's and GitHub's documentation as read on
2026-10-08 and were not tried (nothing can be, before a real publish). Check them again then.

## Ready in the repository

- **Package metadata.** The five published packages (`@kervan/core`, `@kervan/transport`,
  `@kervan/spec-runtime`, `kervan`, `create-kervan`) share the version `0.1.0-rc.1`, and each has
  `repository` (this repository, with its `directory`), `bugs`, `homepage`
  (`https://getkervan.dev`), `author` ("Kervan contributors", no email), `license` (MIT),
  `publishConfig` (`access: public`, `tag: next`) and a `files` allow list without sources, tests
  or source maps. The repository address is written once in the root `package.json`;
  `scripts/test/repository.test.ts` checks the packages, the site's `params.repoURL`, CODEOWNERS,
  the issue template, SECURITY.md, CONTRIBUTING.md and README.md against it.
- **`pnpm test:pack`** (`scripts/pack-check.mjs`): packs each package with `pnpm pack` (which
  writes real versions in place of `workspace:`), checks every tarball against its allow list, a
  deny list (environment files, databases, keys, tests, sources, source maps, local tool files,
  screenshots), a size budget, source-map references and build output whose source is gone, then installs the tarballs with npm in a temporary folder outside
  the repository and runs smoke tests: `kervan --help`, `kervan run --help`, a tool call through
  `createApp` and `createTestClient`, `kervan run` on the example spec answering `tools/list`, and a
  project made by `create-kervan` passing its own tests. CI and `release.yml` run it.
- **`pnpm verify:published [--tag next]`** (`scripts/verify-published.mjs`), after a release:
  compares the registry's metadata for the five packages with the repository's, checks each
  tarball's sha512 and contents, and runs the smoke tests on the packages installed by the tag. It
  reads from the registry and publishes nothing.
- **`release.yml`** runs only by hand, only from `main`, one run at a time, behind the `release`
  environment; it runs the whole chain and `test:pack`, refuses a pre-release under `latest`, runs
  the guard for every package, and skips a version already on npm (so a run that stopped halfway
  can be run again).

## The first release, in order

**Why this order.** npm attaches provenance only to packages published from a **public**
repository ([npm: trusted publishing](https://docs.npmjs.com/trusted-publishers)). And on GitHub
Free, a **private** repository has no branch protection or rulesets and no environment protection
rules (required reviewers), so the `release` environment's approval does not exist until the
repository is public. So: push while private, make it public, then publish.

### 1. GitHub, while the repository is private (the maintainer; Claude Code does none of this)

- [ ] Create an **empty private repository** `aligoren/getkervan`: no README, no license, no
      `.gitignore` (the repository has its own; GitHub's would make the first push conflict).
- [ ] The first push, from the maintainer's own machine (the local `pre-push` hook runs):
      `git remote add origin https://github.com/aligoren/getkervan.git`, then
      `git push -u origin main`.
- [ ] Check that CI runs green. Private repositories on GitHub Free have a monthly quota of
      Actions minutes, and Windows runners use them faster than Linux (check the current
      rates on GitHub's billing page): CI runs a Linux and Windows matrix on
      every push, so watch the usage (Settings, Billing) while private.
- [ ] What GitHub Free does **not** offer a private repository (from GitHub's plan pages,
      **Verify on release day**): branch protection and rulesets, environment protection rules
      (required reviewers, wait timers), environment secrets and environment variables (so
      `KERVAN_ALLOW_PUBLISH` cannot even be set), enforced code owners, secret scanning and push
      protection, private vulnerability reporting. Dependabot alerts do work. None of these block
      the private phase; they are set up in step 2.

### 2. Make it public, then set it up

- [ ] Settings, General, Danger Zone, **Change visibility** to public.
- [ ] Security: enable **private vulnerability reporting** (SECURITY.md and the issue template
      link to its form, `.../security/advisories/new`), **secret scanning** and **push
      protection**, **Dependabot alerts** and **security updates**. Version updates come from
      `.github/dependabot.yml`; check that Dependabot reads this pnpm version's lockfile.
- [ ] A **ruleset** (or branch protection) for `main`: pull requests required, the CI checks
      required (each `test (...)` job, `site` and `e2e`), no force pushes, no deletion, review from
      code owners (`.github/CODEOWNERS` names `@aligoren`).
- [ ] Settings, Actions, General: default workflow permissions **read-only**; require actions
      pinned to a full commit SHA (every workflow already is, `scripts/test/workflows.test.ts`).
- [ ] Settings, Environments: create **`release`** with a **required reviewer** and deployment
      branches limited to `main`. Do not set `KERVAN_ALLOW_PUBLISH` yet. When it is set, it
      is set **on this environment only**: `vars.KERVAN_ALLOW_PUBLISH` in `release.yml` would also
      read a repository or organization variable of that name, so make sure none exists.

### 3. npm

- [ ] The `@kervan` organization exists. Check that the unscoped names are still free
      (`npm view kervan`, `npm view create-kervan`: E404) and register them with the same account.
- [ ] Two-factor authentication for every maintainer, and required on the organization.

### 4. Two branches: `release/0.1.0-rc.1` before, `post-publish/0.1.0-rc.1` after

- [ ] **`release/0.1.0-rc.1`** (pull request into `main`, merged **before** publishing): removes
      the "**Not published yet.**" notes from the five package READMEs (`packages/*/README.md`),
      nothing else. `guard-publish` refuses while a note is there, and the README in a tarball is
      part of that version forever. The site and the root README still say "not on npm yet",
      which stays true until the packages are published.
- [ ] **`post-publish/0.1.0-rc.1`** (built on the release branch; pull request into `main`, merged
      only **after** `0.1.0-rc.1` is on npm and checked, step 7): the site's `params.published`
      becomes true, the install commands name the tag (`npm create kervan@next my-server`,
      `npm install @kervan/core@next`; plain `npm install` installs `latest`), and the root README
      and the site's "not on npm yet" notes become "0.1 release candidate".
- [ ] Read [`docs/REVIEW-NOTES.md`](REVIEW-NOTES.md): decide for each **open** item whether it
      waits or blocks the release.
- [ ] CI green on the release pull request; `pnpm test:pack` passes locally on Windows and Linux;
      merge it.

### 5. Before anything is published: the website is live

Every package's `homepage` and its README's documentation links point at `https://getkervan.dev`,
and a published README cannot be changed. Deploy the site first ([The website](#the-website)) and
open a few of the linked pages (`/docs/framework/`, `/docs/framework/quickstart/`,
`/docs/framework/spec-reference/`).

### 6. The first publish: `0.1.0-rc.1`, by hand, without provenance

A trusted publisher is configured in a package's settings on npmjs.com, so the package must exist
first. `npm stage publish` needs an existing package too (npm 11.19's documentation lists it under
prerequisites), so it cannot create one. The first version of each name is therefore published once
from the maintainer's machine, with a short-lived **granular access token** limited to these five
packages (or an interactive `npm login` with two-factor authentication). That version has **no
provenance**; the next one (`rc.2` or `0.1.0`) goes through `release.yml` with provenance.

The commands, for PowerShell and for bash: [rc.1: step by step](#rc1-step-by-step).

Then, for each of the five packages, add the **trusted publisher** (package settings on npmjs.com):
GitHub Actions, repository `aligoren/getkervan`, workflow `release.yml`, environment `release`.
**Verify on release day** (npm's documentation as read on 2026-10-08):

- a configuration created after 2026-09-03 allows only `npm stage publish` by default: tick
  **`npm publish`** under its allowed actions, or `release.yml` (which runs `npm publish`) is
  refused;
- a configuration expires if no publish succeeds through it within **two days**: add it only when
  the next workflow release is about to run;
- letting a trusted publisher change dist-tags is a separate opt-in (announced 2026-09-30), and
  npm's documentation names npm 11.21.0 or 12.2.0 as the first versions that can use it (the
  workflow sets the tag while publishing, which is not that permission);
- trusted publishing needs at least npm 11.5.1 and Node.js 22.14 (`release.yml` runs Node.js 24
  and stops if its npm is older).

Do not run `release.yml` for `0.1.0-rc.1` after this: it would skip all five packages (they are on
npm already) and publish nothing.

### 7. Check

- [ ] `npm dist-tag ls @kervan/core` (and the other four): `next: 0.1.0-rc.1`. **Verify on
      release day** what `latest` shows: the npm documentation read on 2026-10-08 does not say
      whether the first version of a package published with `--tag next` also becomes `latest`.
      If it did, it stays there until `0.1.0` is published under `latest`; nothing needs fixing.
      If no `latest` exists, plain `npm install @kervan/core` fails until `0.1.0`: the install
      commands must say `@next` (step 4).
- [ ] On a clean machine: `npm create kervan@next my-server`, `npm test` and `npm start` in it.
      A project made from the release candidate depends on `^0.1.0-rc.1`, which also matches
      `0.1.0` later; a plain `^0.1.0` range never matches a pre-release.
- [ ] Tag the commit `v0.1.0-rc.1` and publish a GitHub **pre-release** with the notes.
- [ ] From the first version published by `release.yml` on: the provenance badge on each
      package's npm page. Then, in each package's npm settings, "Require two-factor
      authentication and disallow tokens".

**Published metadata cannot change.** The `package.json` and the README of a published version
are fixed: a wrong description, link or note needs a new version. Only the dist-tags, the
deprecation message and the package's settings on npmjs.com can change afterwards.

## rc.1: step by step

The maintainer runs these on their own machine, after the `release/0.1.0-rc.1` pull request is
merged and before the `post-publish/0.1.0-rc.1` one is. Each step has a PowerShell block (Windows)
and a bash block (Linux, macOS, Git Bash); run one of them, in one terminal, from top to bottom.
In PowerShell keep the default `$ErrorActionPreference` (`Continue`): the blocks read npm's exit
codes themselves, and with `Stop` the first "not found" from `npm view` ends step 5 before it
publishes anything. Lines marked **Verify on release day** come from npm's documentation as read
on 2026-10-08 and could not be tried before a real publish.

Sources: [npm init / npm create](https://docs.npmjs.com/cli/v11/commands/npm-init),
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish),
[npm 11.0.0: a pre-release needs an explicit `--tag`](https://github.com/npm/cli/releases/tag/v11.0.0),
[trusted publishing](https://docs.npmjs.com/trusted-publishers),
[two-factor authentication for publishing](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification),
[unpublish policy](https://docs.npmjs.com/policies/unpublish).

### 1. Before

- An npm account that owns the `@kervan` organization, with two-factor authentication (a passkey
  or security key works).
- Signed in to npm on this machine: `npm login` (it opens the browser), then `npm whoami` prints
  the account's name.
- The unscoped names are still free: `npm view kervan` and `npm view create-kervan` end with
  `E404`.
- The release pull request is merged and CI on `main` is green.

### 2. A fresh clone of `main`, built and checked

A fresh clone, because an old checkout's `dist` can hold files whose sources were deleted
(`test:pack` refuses them too).

```powershell
git clone https://github.com/aligoren/getkervan.git kervan-release
Set-Location kervan-release
git log -1 --format="%h %s"     # the merge of release/0.1.0-rc.1
git status --porcelain          # prints nothing
node --version                  # 22.23.3 or a later 22.x, or 24.21.0 or later
npm --version                   # 11.x
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:pack                  # ends with "test:pack passed."
```

```sh
git clone https://github.com/aligoren/getkervan.git kervan-release
cd kervan-release
git log -1 --format="%h %s"     # the merge of release/0.1.0-rc.1
git status --porcelain          # prints nothing
node --version                  # 22.23.3 or a later 22.x, or 24.21.0 or later
npm --version                   # 11.x
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:pack                  # ends with "test:pack passed."
```

### 3. The guard, for every package

`npm publish <tarball>` does not run `prepublishOnly`, so the guard runs by hand: it refuses
without `KERVAN_ALLOW_PUBLISH=1`, and while a package README still says "Not published yet".
Nothing is printed when it passes.

```powershell
$env:KERVAN_ALLOW_PUBLISH = "1"
try {
  foreach ($dir in Get-ChildItem packages -Directory) {
    Push-Location $dir.FullName
    node ../../scripts/guard-publish.mjs
    $ok = $LASTEXITCODE -eq 0
    Pop-Location
    if (-not $ok) { throw "The guard refused $($dir.Name)." }
  }
} finally {
  Remove-Item Env:KERVAN_ALLOW_PUBLISH
}
```

```sh
for dir in packages/*/; do
  (cd "$dir" && KERVAN_ALLOW_PUBLISH=1 node ../../scripts/guard-publish.mjs) || { echo "The guard refused $dir"; break; }
done
```

If the guard refuses a package, stop here: do not go on to step 4. (A tarball carries no
`prepublishOnly`, so nothing later runs the guard again. Its `publishConfig.tag` is `next`, so
even a publish without `--tag` would not land on `latest`.)

### 4. Pack

`pnpm pack` writes the real versions (`^0.1.0-rc.1`) in place of the `workspace:^` dependencies;
`npm publish` run inside a package folder would publish `workspace:^` as it is, and no npm client
could install it. `pnpm publish` would convert them too, but it was never tried with npm's
browser sign-in; `npm publish <tarball>` publishes exactly what `pnpm pack` made, the files
`test:pack` checked.

```powershell
$out = Join-Path (Resolve-Path ..) "kervan-tarballs"
New-Item -ItemType Directory $out | Out-Null
pnpm -r --filter "./packages/*" pack --pack-destination $out
Get-ChildItem $out -Name        # five .tgz files, each ending in -0.1.0-rc.1.tgz
```

```sh
out="$(cd .. && pwd)/kervan-tarballs"
mkdir "$out"
pnpm -r --filter "./packages/*" pack --pack-destination "$out"
ls "$out"                       # five .tgz files, each ending in -0.1.0-rc.1.tgz
```

### 5. Publish, dependencies first

`@kervan/core`, then `@kervan/transport`, `@kervan/spec-runtime`, `kervan` and `create-kervan`, so
no package is ever on npm without its dependencies. `--tag next`: npm 11 refuses a pre-release
without an explicit tag, and a plain `npm install` asks for `latest` (whether the first publish of
a new package also sets `latest` is checked in step 6). `--access public`:
scoped packages are private by default. A version already on npm is skipped, so after an
interruption (a failed sign-in, the network) the same block simply runs again. **Verify on release
day:** with a passkey, npm may open the browser to confirm every publish, so up to five times.

```powershell
Set-Location $out
$version = "0.1.0-rc.1"
$packages = [ordered]@{
  "kervan-core"         = "@kervan/core"
  "kervan-transport"    = "@kervan/transport"
  "kervan-spec-runtime" = "@kervan/spec-runtime"
  "kervan"              = "kervan"
  "create-kervan"       = "create-kervan"
}
foreach ($file in $packages.Keys) {
  $name = $packages[$file]
  npm view "$name@$version" version 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { "$name@$version is on npm already: skipped"; continue }
  npm publish "./$file-$version.tgz" --tag next --access public
  if ($LASTEXITCODE -ne 0) { throw "npm publish stopped at $name." }
}
```

```sh
cd "$out"
version=0.1.0-rc.1
for entry in kervan-core:@kervan/core kervan-transport:@kervan/transport \
             kervan-spec-runtime:@kervan/spec-runtime kervan:kervan create-kervan:create-kervan; do
  name=${entry#*:}
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "$name@$version is on npm already: skipped"
    continue
  fi
  npm publish "./${entry%%:*}-$version.tgz" --tag next --access public || { echo "npm publish stopped at $name"; break; }
done
```

### 6. Check, then tag

Back in the clone (`Set-Location ../kervan-release` or `cd ../kervan-release`):

```powershell
foreach ($name in "@kervan/core", "@kervan/transport", "@kervan/spec-runtime", "kervan", "create-kervan") {
  npm view $name dist-tags
}
pnpm verify:published --tarballs ../kervan-tarballs   # ends with "verify:published passed: 0.1.0-rc.1 under next."
git tag -a v0.1.0-rc.1 -m "0.1.0-rc.1"
git push origin v0.1.0-rc.1
```

```sh
for name in @kervan/core @kervan/transport @kervan/spec-runtime kervan create-kervan; do
  npm view "$name" dist-tags
done
pnpm verify:published --tarballs ../kervan-tarballs   # ends with "verify:published passed: 0.1.0-rc.1 under next."
git tag -a v0.1.0-rc.1 -m "0.1.0-rc.1"
git push origin v0.1.0-rc.1
```

- Every package shows `next: '0.1.0-rc.1'`. **Verify on release day** what `latest` shows: npm's
  documentation does not say whether the first version of a new package gets `latest` too when it
  is published with `--tag next`. If `latest` is `0.1.0-rc.1`, leave it: it is the only version,
  and `0.1.0` moves it. If there is no `latest`, plain `npm install @kervan/core` fails until
  `0.1.0`; the post-publish branch says `@next` everywhere, so nothing needs changing. Adding
  `latest` by hand (`npm dist-tag add @kervan/core@0.1.0-rc.1 latest`) would hand the release
  candidate to everyone; not recommended.
- `pnpm verify:published --tarballs ../kervan-tarballs` asks the public registry (not one npm is
  configured with) about the five packages: their metadata against the repository's (version,
  dist-tag, license, engines, repository), each `dist.integrity` against the sha512 of the tarball
  published in step 5 (the registry serves exactly those bytes), and the downloaded tarball's files
  against `test:pack`'s allow list. Then it installs the packages by `@next` outside the repository
  and runs the smoke tests. It publishes nothing.
- Publish a GitHub **pre-release** for the tag, with the notes.
- Merge the `post-publish/0.1.0-rc.1` pull request (the site then shows the npm commands).

### 7. Trusted publishing, for the next version

Configured per package on npmjs.com (Settings, Trusted publishing): GitHub Actions, repository
`aligoren/getkervan`, workflow `release.yml`, environment `release`. **Verify on release day:**
tick **`npm publish`** under the allowed actions (a configuration created after 2026-09-03 allows
only `npm stage publish` by default), and add it only when the next version (`0.1.0-rc.2` or
`0.1.0`) is about to go through `release.yml`: a configuration expires if no publish succeeds
through it within two days. After that first workflow release, "Require two-factor authentication
and disallow tokens" in each package's settings.

### 8. If something is wrong

- A broken rc.1: publish `0.1.0-rc.2` with the fix, then for each package
  `npm deprecate "@kervan/core@0.1.0-rc.1" "Broken: use 0.1.0-rc.2"`. An empty message, `""`,
  undoes it; Windows PowerShell 5.1 drops an empty argument, so run the undo in cmd or bash.
- Published by mistake: within 72 hours, and in reverse order (`create-kervan` first, `@kervan/core`
  last, because the packages depend on each other), `npm unpublish <name>@0.1.0-rc.1`. It is each
  package's only version, so npm asks for `--force`, which removes the whole package; its name
  cannot be published again for 24 hours, and the version number never again. Rules:
  [When a release goes wrong](#when-a-release-goes-wrong).

## The website

The site is built by Hugo from `site/` ([docs/SITE.md](SITE.md)). It is not deployed yet. These
steps need the Cloudflare account and the domain.

**Cloudflare Pages**

- [ ] Workers & Pages, Create, Pages, **Connect to Git**: the repository, production branch `main`.
- [ ] Build settings: framework preset **None** (the command below does what the Hugo preset
      would, plus the version check), build command
      `(git fetch --unshallow || true) && node scripts/site/build.mjs && node scripts/check-site.mjs --strict`,
      build output directory
      `site/public`, root directory empty (the build needs `examples/`, `packages/`, `apps/` and
      `docs/`, which Hugo mounts). The strict check fails the deploy if `params.repoURL` is a
      placeholder (it is set to the repository now) or a page shows an npm command before
      `params.published` is true, so nothing half-ready goes live.
      Cloudflare clones shallowly; without the unshallow step every page's `lastmod` in the
      sitemap would be the latest commit's date.
- [ ] Environment variables (production and preview): `HUGO_VERSION` = the content of
      `site/.hugo-version` (0.167.0 today), `NODE_VERSION` = `24`, `SKIP_DEPENDENCY_INSTALL` = `1`
      (the build needs no npm packages; installing the workspace would build native modules for
      nothing).
- [ ] Check the first build's log: `hugo v0.167.0` and no warnings (the build fails on any).
- [ ] `_headers` and `_redirects` from `site/static/` are applied by Pages without settings.
      Preview deployments (`*.pages.dev`) get `X-Robots-Tag: noindex` from `_headers`; the
      production domain never does (check:site fails otherwise).

**Domain**

- [ ] Custom domains: add `getkervan.dev`; Cloudflare shows the DNS record. Leave the `MX`
      records of the email forwarding as they are.
- [ ] `www.getkervan.dev`: add it as a custom domain too, then a **Bulk Redirect** (Rules,
      Redirect Rules, Bulk Redirects) `www.getkervan.dev` → `https://getkervan.dev`, 301, with
      "preserve path suffix" and "preserve query string". `_redirects` cannot match a host name.
- [ ] SSL/TLS, Edge Certificates: **Always Use HTTPS** on (http → https). HSTS comes from
      `_headers` (one year, no preload yet; preloading is a separate, slow-to-undo decision).
- [ ] After the first deploy, from any machine:

```sh
curl -sI https://getkervan.dev/ | grep -i -E "content-security-policy|strict-transport|x-robots"
curl -sI https://www.getkervan.dev/docs/ | grep -i location    # https://getkervan.dev/docs/
curl -sI http://getkervan.dev/ | grep -i location             # https://getkervan.dev/
curl -so /dev/null -w "%{http_code}\n" https://getkervan.dev/nothing/   # 404
curl -s https://getkervan.dev/.well-known/security.txt
curl -s https://getkervan.dev/schema/v1.json | head -3          # "$id": "https://getkervan.dev/schema/v1.json"
curl -s https://getkervan.dev/robots.txt                         # Sitemap: https://getkervan.dev/sitemap.xml
```

  (`X-Robots-Tag` must not appear on the production domain.)

**Search engines** (after the first production deploy)

- [ ] Google Search Console: add a **Domain property** for `getkervan.dev`, verify it with the
      DNS TXT record Search Console shows (`google-site-verification=...`; it goes into DNS, not
      into the repository). Submit `https://getkervan.dev/sitemap.xml`. Use URL Inspection on
      `/` and `/docs/framework/quickstart/` and request indexing.
- [ ] Bing Webmaster Tools: import from Search Console, or verify with its DNS record; submit the
      sitemap.
- [ ] A week later: `site:getkervan.dev` in both search engines; Search Console's Pages report
      for pages "Discovered, not indexed" or excluded, and Core Web Vitals once there is data.

**Release day (the packages are on npm)**

- [ ] `site/hugo.toml`: `params.published = true` (`params.repoURL` is already set).
- [ ] Search `site/content` for `check="source"` and `check="clone"` blocks: the install steps
      now read `npm create kervan@next` during the release candidate (`@latest` from 0.1.0);
      turn the from-source steps that remain useful into a
      "from source" section, and mark the npm ones `published`.
- [ ] Changelog: replace "0.1 in preparation" with the release notes and date.
- [ ] `pnpm site:verify --examples --network` and `pnpm check:site --strict` pass (strict fails
      while an npm command is shown unpublished).
- [ ] Add `# yaml-language-server: $schema=https://getkervan.dev/schema/v1.json` where noted above.
- [ ] Deploy (merge to `main`), then check a page's `og:image` and canonical URL in the HTML and
      with a link preview (a chat app or the social networks' preview tools).
- [ ] Mailboxes: `hello@`, `security@` and `conduct@getkervan.dev` reach a person
      (`conduct@` is new with the site's footer and CODE_OF_CONDUCT.md: add its forwarding).

**Every year:** renew `Expires` in `site/static/.well-known/security.txt` (check:site warns 30
days ahead; `site-check.yml` fails then).

## Runner images

The Ubuntu jobs run on `ubuntu-24.04`, not `ubuntu-latest`: GitHub moves `ubuntu-latest` to Ubuntu
26 from 2026-10-19, and a new image changes the system packages Playwright installs
(`playwright install --with-deps`) and the environment of the pinned Hugo download
(`scripts/site/install-hugo.sh`). The move to Ubuntu 26 is a deliberate change of its own: one
pull request that changes the label in every workflow (`scripts/test/workflows.test.ts` accepts
only the pinned one) and passes CI, the site job and e2e included. Windows stays on
`windows-latest`.

The CI job names include the runner (`test (ubuntu-24.04, Node 22.x)`): a ruleset that requires
checks by name needs the new names after such a change.

## How a release runs

After the first release (above), every release:

0. For `0.1.0` and later stable releases: set `npmTag = "latest"` in `site/hugo.toml` in the same
   pull request as the post-publish changes (the site's install commands then drop the `@next`).

1. Check [`docs/REVIEW-NOTES.md`](REVIEW-NOTES.md) for open items that should be done first, and
   update it with anything new.
2. A pull request sets the new version in all five `package.json` files (one version for all;
   `scripts/test/repository.test.ts` fails otherwise) and updates the release notes. A
   pre-release keeps `publishConfig.tag: next`; for a release under `latest` the workflow's
   dist-tag input decides (the command line's `--tag` wins over `publishConfig`). CI is green,
   `pnpm test:pack` passes; it is merged.
3. On the `release` environment (never as a repository or organization variable),
   `KERVAN_ALLOW_PUBLISH` = `1`.
4. Actions, **Release**, Run workflow on `main`, the dist-tag: `next` for a pre-release, `latest`
   for a release (the workflow refuses a pre-release under `latest`).
5. A reviewer approves the `release` environment.
6. The workflow runs the whole chain and `test:pack`, packs the packages, runs the guard for each,
   and publishes them in dependency order with provenance. If it stops halfway, run it again: the
   versions already on npm are skipped.
7. `KERVAN_ALLOW_PUBLISH` back to empty. Check `npm dist-tag ls @kervan/core`, the provenance
   badge, and a fresh `npm create kervan@<version> my-server` on a clean machine.
8. Tag the commit (`v0.1.0`) and publish the GitHub release with the notes.

## When a release goes wrong

npm's rules as read on 2026-10-08 ([unpublish policy](https://docs.npmjs.com/policies/unpublish),
[deprecate](https://docs.npmjs.com/cli/commands/npm-deprecate)); **Verify on release day**.

- **A broken release** (it installs but misbehaves): publish a fixed version. Mark the bad one,
  for each affected package: `npm deprecate @kervan/core@0.1.1 "Broken: use 0.1.2"` (an empty
  message, `""`, undoes it). Move a tag back if needed: `npm dist-tag add @kervan/core@0.1.0 latest`
  (or `next` for a release candidate).
- **Published by mistake** (wrong content, or before it was meant to be): a version can be
  unpublished within 72 hours if no other package on the registry depends on it; after 72 hours
  only if nothing depends on it, it had fewer than 300 downloads in the last week and it has a
  single owner. The Kervan packages depend on each other, so unpublish in reverse order:
  `create-kervan`, `kervan`, `@kervan/spec-runtime`, `@kervan/transport`, `@kervan/core`
  (`npm unpublish <name>@<version>`; when it is a package's only version, npm refuses without
  `--force`, which removes the whole package). An unpublished version number can never be used
  again; after unpublishing every version of a package, its name cannot be published again for
  24 hours. Otherwise deprecate it and publish
  a corrected version.
- **A secret or private file in a tarball:** treat the secret as leaked whatever you do next:
  revoke and rotate it first. Then unpublish if npm still allows it (and contact npm support),
  otherwise deprecate, and publish a clean version. Find out why `test:pack` did not catch it and
  add a rule to `scripts/pack-check.mjs`.
- **A security fix:** follow SECURITY.md: a private GitHub security advisory, a fixed release,
  then publish the advisory (with a CVE) so `npm audit` warns users. Deprecate the affected
  versions with a pointer to the advisory.
- **A compromised maintainer account or workflow:** revoke tokens and sessions, check the npm
  packages' versions and provenance (each must come from `release.yml` on this repository),
  deprecate anything not built by the workflow, and tell users in an advisory.

## Open decisions

### a) The first version: 0.1.0, or a pre-release first? (decided: `0.1.0-rc.1`)

The packages are set to `0.1.0-rc.1` with `publishConfig.tag: next`. The reasoning, for the
record:

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
