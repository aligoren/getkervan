# Deploying the website

The website at `https://getkervan.dev` is the `site/` folder, served as static files. There is no
build step and nothing to install.

| Path | What it is |
| --- | --- |
| `index.html` | The single page: what Kervan is, how to start, contact details. No scripts, fonts or third-party requests. |
| `schema/v1.json` | The `kervan.yaml` editor schema, the address its `$id` names. |
| `.well-known/security.txt` | Where to report vulnerabilities ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)). |
| `_headers` | Response headers for Cloudflare Pages (CSP, `nosniff`, CORS and content type for the schema). |
| `CNAME`, `.nojekyll` | For GitHub Pages: the custom domain, and serving `.well-known` (Jekyll would skip dot folders). |

Kervan's code never requests anything from this site. The schema also ships in
`@kervan/spec-runtime`, and validation always uses that copy.

## Before every deploy

```sh
pnpm site:schema   # copy packages/spec-runtime/schema/kervan.schema.json to site/schema/v1.json
pnpm check:site    # date checks: fails if security.txt has expired, warns 30 days before
pnpm test          # format checks (below)
```

`pnpm check:site` fails when `security.txt`'s `Expires` has passed or `site/schema/v1.json` differs
from the package's schema. It warns when `Expires` is less than 30 days away or more than a year
ahead. It is not part of `pnpm test`, so that the test suite never turns red just because time
passed.

The `repo` test project (in `pnpm test`) fails when:

- `site/schema/v1.json` differs from the package's schema;
- `security.txt` lacks a field or has a malformed one (`Contact`, `Expires`, `Canonical`,
  `Preferred-Languages`);
- `index.html` loads anything from another site, contains a script, links to something the site
  does not serve, or offers install commands outside the "Coming soon" section;
- the spec shown on the page no longer loads.

## Option A: Cloudflare Pages

1. In the Cloudflare dashboard: **Workers & Pages → Create → Pages**, then either connect the
   Git repository or choose **Upload assets**.
2. Build settings (Git): framework preset **None**, build command empty, build output directory
   `site`. For uploads, upload the contents of `site/`.
3. **Custom domains → Set up a custom domain → `getkervan.dev`** (and `www.getkervan.dev` if
   wanted, redirected to the apex). Cloudflare shows the DNS record it needs.
4. `_headers` is applied automatically. `CNAME` and `.nojekyll` are ignored.

## Option B: GitHub Pages

1. Repository **Settings → Pages**. Source: **GitHub Actions**, with a workflow that uploads
   `site/` (`actions/upload-pages-artifact` with `path: site`, then `actions/deploy-pages`).
   Alternatively, publish `site/` to a `gh-pages` branch.
2. **Custom domain:** `getkervan.dev` (the `CNAME` file sets it too), then enable **Enforce HTTPS**
   once the certificate is issued.
3. GitHub Pages ignores `_headers`: the CSP and the schema's CORS header are not sent. Editors
   that run outside a browser (VS Code) do not need CORS; browser-based editors fetching the
   schema from another origin would.

## DNS

Set up by the domain owner, following what the chosen host shows:

- **Cloudflare Pages:** the CNAME record Cloudflare proposes (flattened at the apex).
- **GitHub Pages:** apex `A` records `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
  `185.199.111.153` (and the `AAAA` records GitHub lists), plus `www` as a `CNAME` to
  `<owner>.github.io`. Verify the domain in the account's Pages settings to prevent takeover.

Email forwarding (`hello@`, `security@`) uses `MX` records: leave them as they are.

## After deploying

```sh
curl -sI https://getkervan.dev/ | grep -i content-security-policy
curl -s https://getkervan.dev/.well-known/security.txt
curl -s https://getkervan.dev/schema/v1.json | head -3   # "$id": "https://getkervan.dev/schema/v1.json"
```

Then:

- add `# yaml-language-server: $schema=https://getkervan.dev/schema/v1.json` to the generated
  projects' and examples' `kervan.yaml` and to Studio's starter spec (left out until the site is
  live, so editors do not point at a missing file);
- once the repository exists, add its link on the page (`index.html`, "Source code" card) and the
  `repository`, `bugs` and `homepage` fields to the packages' `package.json`.

## Every year

Renew `Expires` in `security.txt` every year: move it forward (at most a year), run
`pnpm check:site`, and redeploy. An expired `security.txt` tells reporters the contact may be
stale.

Once the repository is published, `pnpm check:site` will run as a scheduled CI job (for example
weekly), so the warning 30 days before expiry reaches the maintainers without anyone having to
remember.

## Schema versions

`v1.json` follows `specVersion: 1` and only changes compatibly. A breaking spec format would get
`specVersion: 2` and `schema/v2.json`, with `v1.json` left in place.
