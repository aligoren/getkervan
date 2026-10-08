# The website

`https://getkervan.dev` is built with [Hugo](https://gohugo.io) from `site/`: a landing page, the
framework documentation, the Studio documentation, guides, a changelog and search. It is static
HTML and CSS that reads fine without JavaScript, loads nothing from other sites, and is checked
by tests. Kervan's code never requests anything from it (no telemetry, no update checks, no
remote schemas; `scripts/test/domain.test.ts` keeps the domain out of `src/`).

Deploying it is in [RELEASING.md](RELEASING.md#the-website); this page is about working on it.

## Layout

| Path | What it is |
| --- | --- |
| `site/hugo.toml` | Settings: base URL, `params.published`, `params.repoURL`, contact addresses, and the mounts that bring repository files in. |
| `site/.hugo-version` | The one place the Hugo version is pinned. |
| `site/hugo-checksums.txt` | SHA-256 of the Linux release archives `scripts/site/install-hugo.sh` may download. |
| `site/content/` | The pages, in Markdown. `docs/framework/`, `docs/studio/`, `guides/`, `changelog.md`, `search.md`. |
| `site/layouts/` | Templates (`baseof`, `home`, `page`, `section`, `search`, `404`), partials, shortcodes and render hooks. |
| `site/assets/` | `css/site.css`, the three small scripts (theme, copy buttons, search), the screenshots and the Open Graph base image (processed by Hugo). |
| `site/data/generated/` | Output of real runs (`pnpm site:generate`): what the example server answers, and the CLI `--help` texts. |
| `site/static/` | Copied as is: `_headers`, `_redirects`, `.well-known/security.txt`, `schema/v1.json`, fonts, favicon. |
| `scripts/site/` | Build, serve, generate, screenshots, verify, and the docs example runner. |
| `scripts/check-site.mjs` | `pnpm check:site`: every rule the built site must follow. |

The site is not a dependency of any package, and no package depends on it.

## One source for everything shown

Nothing that exists elsewhere in the repository is copied into `site/` by hand. Hugo mounts it:

| Shown on the site | Comes from |
| --- | --- |
| The landing page's `kervan.yaml` | `examples/spec/kervan.yaml` (mounted; a test compares the page with the file) |
| `tools/list`, `server/discover` and the two tool calls | `site/data/generated/example.json`, written by `pnpm site:generate` from a real `kervan run --http` |
| The `kervan.yaml` reference | `packages/spec-runtime/schema/kervan.schema.json`, rendered at build time |
| CLI reference | `site/data/generated/cli-help.json` (the real `--help` output) and `packages/cli/README.md` |
| Framework pages on the API, transports, errors, middleware | `packages/*/README.md` and `docs/API.md`, included by section (`include` shortcode) |
| Studio pages | `apps/studio/README.md` and `docs/THREAT-MODEL-STUDIO.md`, included by section |
| Colors | `apps/studio/web/src/ui/theme.css`, the light, system-dark and chosen-dark token blocks |
| Font | Inter Variable, Latin subset, the same file Studio ships (`@fontsource-variable/inter`), with its OFL license |
| `schema/v1.json` | `pnpm site:schema` copies the package schema; a test keeps them equal |

The `include` shortcode leaves out "Not published yet" notes (the site says that itself), points
relative links at the source repository, and while `params.published` is false shows
`node /path/to/kervan/packages/cli/bin/kervan.js` where a README says `npx kervan`.

### Design tokens

`site/layouts/_partials/css.html` reads the three token blocks from Studio's `theme.css` by
their exact headers and fails the build if one is missing. It only adds selectors: the theme
radio buttons in the header (`:has(#theme-dark:checked)`) switch the theme without JavaScript, and
`site.js` remembers the choice in `localStorage` (the only thing it stores). Screenshots follow
the system theme (`<picture>` sources can only test `prefers-color-scheme`), so with the system in
dark and the site switched to light, the pictures stay dark. A test
(`site-build.test.ts`) checks that the built CSS has exactly Studio's values in all three blocks.

## Commands

Hugo is needed for building; Node.js and the repository's dependencies for the rest.

```sh
pnpm site:build              # Hugo into site/public (checks the Hugo version first)
pnpm site:serve              # serves site/public on http://127.0.0.1:4320 with the _headers rules
pnpm check:site              # every rule below on site/public; --strict also fails on warnings
pnpm site:verify             # build, check:site, then every page in Chromium (see Verification)
pnpm site:generate           # refresh site/data/generated (needs the network; --offline keeps the recorded calls)
pnpm site:screenshots        # refresh the Studio screenshots (see below)
pnpm site:schema             # copy the editor schema to site/static/schema/v1.json
```

Run `pnpm build` first for `site:generate`, `site:screenshots` and `site:verify --examples`.

## Hugo version policy

- The version is in `site/.hugo-version` and nowhere else. `pnpm site:build` refuses any other
  version with one line that says how to install the right one. Cloudflare Pages reads it from
  the `HUGO_VERSION` variable, which must match (RELEASING.md).
- The standard edition is enough (no Sass, no image formats that need extended). Extended of the
  same version works too.
- Windows: `winget install Hugo.Hugo --version <v>` (or Scoop, Chocolatey). Linux and CI:
  `scripts/site/install-hugo.sh` downloads the release from GitHub and checks it against
  `site/hugo-checksums.txt` before installing. macOS: the release archive, checked the same way.
- There is no Hugo npm package in the repository.
- To move to a new version: read its release notes for deprecations (the build runs with
  `--panicOnWarning`, so a deprecated setting fails it), update `.hugo-version`, replace the two
  lines in `hugo-checksums.txt` from the release's `hugo_<v>_checksums.txt`, update Cloudflare's
  `HUGO_VERSION`, and run `pnpm site:verify`.

## Screenshots

`pnpm site:screenshots` starts the built Studio with a throwaway data folder in the system's
temporary folder (outside the repository) and a random master key, creates demo data through
Studio's own API (users at `example.test`, servers for Open-Meteo, an issue tracker and a status
page, fake secret values), makes a few real gateway calls so the call log has entries, and takes
each screen at 1440x900 (and two at 390 wide), light and dark, as WebP into
`site/assets/screenshots/` (Hugo publishes them under `/screenshots/`). The temporary folder is
removed at the end.

Before each picture, the page's visible text, field values, titles and alt texts are scanned
(`scripts/site/leaks.mjs`): a real-looking API key or token, an email address outside the
example domains, an IP address outside loopback and the documentation ranges, a home folder
path, this machine's name, user and temporary folder, or the run's setup token, master key,
password or data folder stops the run without writing the picture. Shown-once API keys are
replaced with `kvn_EXAMPLE-KEY-shown-once-in-Studio` before the scan. `site-leaks.test.ts` tests
the scanner and that the script cannot write a picture any other way.

Nothing in Studio was changed for the pictures. When a screen changes, run the command again and
look at the result before committing.

## Verification

Fast, in `pnpm test` (the `repo` project):

- `site.test.ts`: the schema copy, `security.txt`, the font, the contact addresses, the Hugo pin
  and checksums, check:site's date logic.
- `site-build.test.ts` (needs Hugo at the pinned version; skipped without it unless
  `KERVAN_REQUIRE_HUGO=1`): builds into a temporary folder; check:site finds nothing; the tokens
  are Studio's; every code block declares how it is verified, every spec loads, every fragment
  and TypeScript excerpt parses. Then one case per rule: the rule's problem is put into one built
  file and the rule must report it.
- `site-data.test.ts`: the generated data still matches the example spec, today's server answers
  and the CLI's `--help`; recorded calls fit the tools' schemas.
- `site-leaks.test.ts`: the screenshot scanner.

Slow, `pnpm site:verify`:

- every page in Chromium, light and dark, at 1440 and 390 wide, served with the real `_headers`:
  axe-core finds no WCAG 2.2 A/AA or best-practice violation (contrast included); the CSP blocks
  nothing; no request leaves the local server; nothing logs an error; nothing scrolls sideways;
- without JavaScript: the theme switch works, the skip link is the first Tab stop, the search page
  lists every page; with it: copy buttons and search work;
- the home page's first load measured in the browser stays within the budget;
- `--examples` runs the documentation's code blocks against this working tree (below); `--shots
  <dir>` saves pictures of four pages in each variant for a visual check.

### Code blocks in the documentation

Every shell, PowerShell, Dockerfile, Caddyfile, TypeScript and YAML block says how it is checked,
with an attribute on the fence, for example ```` ```sh {check="run"} ````. The kinds are listed
at the top of `scripts/site/docs-examples.mjs`: `run`, `starts` (with the text that shows it is
ready), `repl` (a `kervan dev` transcript, replayed), `ts`/`ts-run` (type-checked against the
packages; `ts-run` also runs), `spec`, `fragment`, `ts-syntax`, `studio-starts`,
`studio-create-admin`, `claude`, `docker`/`docker-run`, `source`/`clone`/`published` (install
steps), and `manual` with a `reason` when a block cannot run here (a public DNS name, a real API
key, a running Studio with a published server).

`pnpm site:verify --examples` runs them. Without flags it runs only what needs no network and
changes nothing outside temporary folders; `--network` adds the REPL calls and the install steps
(a copy of the working tree stands in for `git clone`), `--claude` the Claude Code commands (in a
temporary project, removed afterwards), `--docker` the Dockerfile draft (built, run read-only,
asked with the allowed and another Host header, removed).

Two adjustments, both stated in the runner: a documented `kervan dev` runs with `--http --repl`
(at a terminal that is what it does; with stdin a pipe it would serve stdio instead), and
`corepack enable` is skipped (it writes next to the Node.js installation).

## The rules check:site enforces

On every page: one `<title>` of 10 to 60 characters, unique; one meta description of 120 to 160
characters, unique; one `<h1>`; no skipped heading level; `lang="en"`; an absolute canonical URL
with a trailing slash; Open Graph and Twitter tags with a 1200x630 PNG on the site; one JSON-LD
block with `WebSite` and `Organization` (`SoftwareApplication` on the home page, `BreadcrumbList`
and `TechArticle` elsewhere) and no ratings, reviews, prices or awards; nothing loaded from
another site; no iframe, inline script, inline style or event handler attribute; external links
with `rel="noopener noreferrer"`; internal links and fragments that exist; images with `alt`,
`width` and `height`; no page without a link to it.

For the site: `sitemap.xml` lists exactly the canonical pages, with `lastmod` from git;
`robots.txt` allows everything and names the sitemap; `_headers` has the CSP and the other
headers, and `noindex` only for `*.pages.dev` preview hosts; the performance budget; the framework
book never mentions Studio except the one line pointing to its docs; the landing page shows
`examples/spec/kervan.yaml` unchanged.

Warnings (fail with `--strict`, as CI and release day run it): `params.repoURL` is still the
placeholder; an npm install command in a code block while `params.published` is false;
`security.txt` expires within 30 days.

### Performance budget

| What | Budget |
| --- | --- |
| Home page first load (HTML, CSS, preloaded font, scripts, LCP image) | 200 KiB |
| LCP image | 100 KiB |
| Home page with every image (one variant each) | 600 KiB |
| CSS | 30 KiB |
| JavaScript per page | 5 KiB |
| Font | 50 KiB |
| One screenshot | 120 KiB |
| One HTML page | 150 KiB |

Measured on this build: the home page's first load is about 166 KiB in the browser.

## Before the release, and on release day

`site/hugo.toml` has two switches:

- `params.published = false`: install steps are from source (`pnpm try:new`), commands use
  `node .../kervan.js`, the changelog says 0.1 is in preparation. When the packages are on npm,
  set it to `true`: the `install` and `connect-command` shortcodes switch to `npm create
  kervan@latest` and `npx kervan`. Then search the content for `check="source"` and `check="clone"`
  blocks that should become `published`.
- `params.repoURL`: a placeholder until the repository exists. Every "View source" link and every
  included README link uses it.

The release-day checklist is in [RELEASING.md](RELEASING.md#the-website).

## Claims on the landing page

Every claim on the landing page, and what backs it. When a claim changes, change this table.

| Claim | Backed by |
| --- | --- |
| MIT licensed | `LICENSE`; `license.test.ts` checks every package has it |
| Pre-release, not on npm | `params.published = false`; the packages' "Not published yet" notes; `guard-publish.mjs` |
| On the official MCP SDK, not a rewrite | `@modelcontextprotocol/server`, `/client`, `/hono` dependencies (`packages/*/package.json`) |
| MCP 2026-07-28, stateless; `server/discover`; 2025 clients served too | `packages/transport`; both eras in `packages/transport/test` (`http`, `stdio`, `testing`); the landing page's `server/discover` output is a real answer |
| Arguments validated before the handler; only `ToolError` messages reach the client | `packages/core/src/tool.ts`, `errors.ts`; core's error-masking tests |
| Timeouts, size limits, rate limits, Host and Origin checks by default | `HTTP_DEFAULTS`, `SPEC_LIMITS` (spec-runtime), transport rate limit and `allowedHosts`; their tests |
| SSRF: public addresses only, DNS resolved once and pinned, redirects refused unless allowed then rechecked, metadata always refused | `packages/spec-runtime/src/network.ts`; network tests with mutation runs (CLAUDE.md, Aşama 3) |
| Secret redaction in every encoding Kervan knows | `SecretVault` (raw, URL, form, JSON, number forms) and its tests |
| Studio: AES-256-GCM under a master key you keep | `apps/studio/src/vault.ts`; vault tests |
| Users and roles; sessions end on password and role changes; throttled sign-ins; admin's password for sensitive changes | `apps/studio/src/accounts.ts` (`deleteSessionsOf` on password, role and disable), `limiter.ts`; Studio tests |
| CSRF and exact-origin checks; gateway checks Host and Origin | `apps/studio/src/http.ts`, `gateway.ts`; `apps/studio/test/origin-host.test.ts` |
| `select` in a separate process: empty environment, memory limit, timeout, no network, no file writes, no child processes | `packages/spec-runtime/src/select-child.ts` and `selectProcess()` in `select.ts` (Node permission model, network closed in the child); its tests |
| Audit log the database refuses to change or delete; never a password, key or secret value | database triggers refusing UPDATE and DELETE (`apps/studio/drizzle/0001_immutable.sql`, `0002_integrity.sql`); `test/audit-catalogue.test.ts` |
| Every server exports as `kervan.yaml` and runs with `kervan run` | `apps/studio/src/export.ts`; `apps/studio/test/export.test.ts` |
| "Implemented and covered by tests, including tests that break the check on purpose" | the mutation runs recorded in CLAUDE.md for SSRF, redaction, origin checks and this site's rules |
| The `tools/list` and call output shown | `site/data/generated/example.json` from a real run; `site-data.test.ts` checks it against today's server |

There are no customer names, testimonials, download counts, benchmarks or competitor comparisons
on the site.

## Search engines

Each page has its own title and description written for what someone searching would type, and
a search intent:

| Page | Search intent |
| --- | --- |
| `/` | What Kervan is; "MCP server from YAML", "MCP server framework TypeScript" |
| `/docs/framework/` | Overview of the framework docs |
| `/docs/framework/quickstart/` | Run a first MCP server quickly |
| `/docs/framework/spec-reference/` | Look up a `kervan.yaml` field |
| `/docs/framework/http-tools/` | Describe an HTTP call as an MCP tool |
| `/docs/framework/input-output/` | Map tool arguments and API responses |
| `/docs/framework/select/` | JMESPath `select` syntax and limits |
| `/docs/framework/secrets/` | Pass API keys to a spec safely |
| `/docs/framework/code/` | Write MCP tools in TypeScript with Zod |
| `/docs/framework/transports/` | stdio vs Streamable HTTP, Host checks, fetch runtimes |
| `/docs/framework/protocol/` | What MCP 2026-07-28 changes for a server |
| `/docs/framework/api/` | Which exports are stable |
| `/docs/framework/cli/` | `kervan create`, `dev`, `run` options |
| `/docs/framework/security/` | Kervan's security model, SSRF protection |
| `/docs/framework/deployment/` | Run an MCP server in Docker and behind a proxy |
| `/docs/framework/troubleshooting/` | Fix a specific error message |
| `/docs/framework/versioning/` | Versions, `specVersion`, upgrades |
| `/docs/studio/` | What Kervan Studio is: a self-hosted MCP gateway |
| `/docs/studio/install/` | Install Studio and create the first admin |
| `/docs/studio/data-and-master-key/` | Where Studio keeps data; the master key |
| `/docs/studio/users/` | Roles and user management |
| `/docs/studio/servers/` | Edit a server's spec in Studio |
| `/docs/studio/publishing/` | Publish versions and roll back |
| `/docs/studio/secrets/` | Keep upstream API keys in Studio's vault |
| `/docs/studio/api-keys/` | Connect MCP clients to Studio with API keys |
| `/docs/studio/playground/` | Try tools before publishing |
| `/docs/studio/call-logs/` | See who called which tool |
| `/docs/studio/audit/` | Who changed what and when |
| `/docs/studio/profile/` | Own password, sessions, theme |
| `/docs/studio/configuration/` | Environment variables, reverse proxy |
| `/docs/studio/backup/` | Back up, restore, upgrade |
| `/docs/studio/security/` | Studio's threat model |
| `/docs/studio/limits/` | Known limits |
| `/docs/studio/troubleshooting/` | Fix Studio problems |
| `/docs/studio/export/` | Leave Studio: export a server as `kervan.yaml` |
| `/guides/` | Step-by-step guides |
| `/guides/what-is-mcp/` | "What is MCP" and where Kervan fits |
| `/guides/mcp-server-from-yaml/` | "Build an MCP server from YAML" (a Hacker News example) |
| `/guides/rest-api-as-mcp-tools/` | "Expose a REST API as MCP tools" |
| `/guides/connect-claude-code/` | "Add an MCP server to Claude Code" |
| `/guides/self-host-mcp-gateway/` | "Self-hosted MCP gateway" for a team |
| `/changelog/` | Release notes |
| `/search/` | Search, and a list of every page |

Nothing here guarantees a ranking. What the site controls is that every page is reachable,
described, fast, accessible and honest about what exists; the rest is up to the search engines
and to people linking to it. Registering the site in Google Search Console and Bing Webmaster
Tools, and submitting the sitemap, are release-day steps (RELEASING.md).

## Dependencies

The site added two root `devDependencies`, both pinned:

- `@playwright/test` 1.63.0 (Apache-2.0): drives Chromium for `site:screenshots` and
  `site:verify`. Studio's E2E tests already use the same version; the root needs its own entry
  because the scripts live outside `apps/studio`.
- `axe-core` 4.13.0 (MPL-2.0): the accessibility rules `site:verify` runs in each page. It is
  evaluated through the browser's DevTools protocol, never shipped with the site.

Hugo is installed separately (above). The font comes from Studio's existing
`@fontsource-variable/inter` dependency. The site itself ships no third-party code.

## Every year

`security.txt`'s `Expires` must stay in the future: move it forward (at most a year) and
redeploy. `pnpm check:site` warns 30 days ahead; once the repository is public, the weekly
`site-check.yml` runs it with `--strict` so the warning fails a run.

## Schema versions

`v1.json` follows `specVersion: 1` and only changes compatibly. A breaking spec format would get
`specVersion: 2` and `schema/v2.json`, with `v1.json` left in place.
