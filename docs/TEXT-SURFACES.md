# User-supplied text: where it is shown

Every string that someone other than the operator can choose, the surfaces it reaches, and how
each surface treats it. Built in the release security review; keep it up to date when a new
field or surface is added. The rules behind it are in `THREAT-MODEL-STUDIO.md` (T4, T17, T20).

"Hidden characters" below means controls, bidi controls, zero-width, tag and other format
characters, line and paragraph separators, and blank-looking letters (Hangul fillers, the braille
blank).

## Studio accounts and objects

| Input | Who chooses it | Checked in | Reaches | Treatment |
| --- | --- | --- | --- | --- |
| Email (setup, adding a user, changing an email) | admin | `apps/studio/src/accounts.ts`, `display-text.ts` | UI (users, audit names), API JSON, `reset-admin` output | Hidden characters refused (400, names the code point); may not read as another user's display name. React text. |
| Email of a failed sign-in | anyone | `api/routes.ts` (`sanitizeDisplayText`) | audit row, audit page | Kept for the record with hidden characters as visible escapes and backslashes doubled; 320 characters. |
| Display name | each user | `accounts.ts`, `display-text.ts` | UI (shell, users, audit names), API JSON | Hidden characters refused; may not read as a reserved label or as any email (no account oracle). React text. |
| Server name | members | `studio.ts` (`unsafeTextProblem`) | UI, audit names | Hidden characters refused. React text. |
| Server slug | members | `studio.ts` (`[a-z0-9-]`) | UI, audit details, `claude mcp add` command, export file name | Plain ASCII; nothing a shell would act on. |
| Secret name | admins | `secrets.ts`, spec schema (`[A-Z][A-Z0-9_]*`) | UI, audit, spec issues, logs | Plain ASCII. |
| API key name | admins | `studio.ts` | UI (keys, "Caller" column) | Hidden characters refused. React text. |
| Client IP (`X-Forwarded-For`) | network | `client-ip.ts` (`isIP`) | audit, rate-limit keys | Entries that are not IP addresses are never used. |
| User-Agent | browser | `db/repos/sessions.ts` (200 characters) | profile sessions (device name; raw text only in a tooltip) | React attribute. |
| Hash route (`#/servers/<id>`) | anyone who sends a link | `web/src/App.tsx` | the page shown | Only UUID characters make a server link; anything else shows the server list. |

## Spec text

| Input | Who chooses it | Checked in | Reaches | Treatment |
| --- | --- | --- | --- | --- |
| Spec `name`, `version` | spec author (member) | `packages/spec-runtime/src/spec-schema.ts` | MCP `serverInfo` (gateway, `kervan run`), `kervan run` terminal lines | Hidden characters (line breaks too) refused at load. |
| Spec `description` | spec author | `spec-schema.ts` | MCP `instructions` (the model), playground | Hidden characters refused at load, except line feed and tab; ZWNJ and ZWJ allowed. |
| Tool `title`, annotation `title` | spec author | `spec-schema.ts` | `tools/list` (people and the model), playground tool list, `kervan dev` | Hidden characters refused at load. |
| Tool `description` | spec author | `spec-schema.ts` | `tools/list`, playground, `kervan dev` `tools` | Hidden characters refused, except line feed and tab. |
| `title` / `description` inside input and output schemas | spec author | `packages/spec-runtime/src/schema-limits.ts` | `inputSchema` / `outputSchema` (the model, clients) | Hidden characters refused (line feed and tab allowed in descriptions). |
| Tool name | spec author | `spec-schema.ts` (`[A-Za-z0-9_.-]`) | everywhere | Plain ASCII. |
| Unknown field names, other YAML keys | spec author | `packages/spec-runtime/src/load.ts` | spec issues (Studio editor, `kervan run` errors) | Quoted, every hidden character (line breaks too) spelled out as an escape. |
| Spec YAML text (comments, values) | spec author | YAML parser and schema | Monaco editor, version diff, exported `kervan.yaml` | Editor marks hidden characters; the diff shows them as marked escapes; the export is byte for byte (comments included). |

## Data from upstreams and clients

| Input | Who chooses it | Checked in | Reaches | Treatment |
| --- | --- | --- | --- | --- |
| Upstream response | upstream API | spec-runtime redaction, `select` | MCP clients and the model, playground output, call log, `kervan dev` inspector | Secrets redacted before `select` (numbers too). UI: React text with hidden characters as marked escapes. Terminal: controls and format characters as visible escapes. |
| Tool arguments | MCP client | input JSON Schema | upstream request (escaped per context), call log (opt-in) | Template values are data, never templates; CR/LF in headers refused. Call log: redacted, 4 KiB, marked escapes in the UI. |
| Error messages (spec issues, upstream status) | spec author, upstream | spec-runtime | Studio UI, `kervan run` / `kervan dev` | Upstream text never enters a message (status code and standard reason only). UI: marked escapes. Terminal: visible escapes. |
| A dev server's own stderr | the developer's code | `packages/cli/src/dev` | `kervan dev` terminal | Visible escapes for controls; secret-looking variables and URL passwords redacted. |
| Audit details | Studio | `db/repos/audit.ts` | audit page | Names, ids, hosts and counts only (already checked above). |

## Surfaces and their rule

| Surface | Rule |
| --- | --- |
| Studio web UI | Only React text (never HTML, Markdown, links or images from untrusted text); CSP `script-src 'self'`. Untrusted text goes through `Visible` (`web/src/components/untrusted.tsx`). |
| Studio console (stderr) | Fixed messages; data through `inspect` (escaped, one line) and redacted. |
| MCP clients and the model | What the spec says, without hidden characters; upstream data redacted and selected. |
| CLI terminal (`kervan run`, `kervan dev`, `kervan create`) | Every line through `terminalSafe` (`packages/cli/src/terminal.ts`). |
| Exported `kervan.yaml` | The saved text exactly; bindings, never secret values. |
| `claude mcp add` command in the UI | Built from the public URL, a UUID, the slug and a base64url key only. |
