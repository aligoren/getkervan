---
title: Build an MCP server from a YAML file
seoTitle: 'Build an MCP server from a YAML file'
description: Step by step, write a kervan.yaml that turns the public Hacker News API into two MCP tools, check it, try it in a REPL, and serve it over stdio or HTTP.
lead: A complete MCP server without code. The file below turns two calls of the public Hacker News API into tools; each step was run as written.
weight: 20
---

You need Kervan built from a clone ([quickstart](/docs/framework/quickstart/)); the commands run
in the repository folder. The tools call the public Hacker News API, so the network is needed.

## 1. Write the spec

Save this as `hn.yaml`:

```yaml {check="spec" id="hn"}
specVersion: 1
name: hacker-news
version: 0.1.0
description: Read-only access to Hacker News stories through its public API.
tools:
  - name: top_stories
    title: Top stories
    description: The ids of the ten current top stories on Hacker News, best first.
    annotations: { readOnlyHint: true }
    input: { type: object, properties: {} }
    http:
      url: https://hacker-news.firebaseio.com/v0/topstories.json
    output:
      select: "[:10]"
  - name: get_item
    title: Story or comment
    description: One Hacker News item by id, with its title, author, score and link.
    annotations: { readOnlyHint: true }
    input:
      type: object
      properties:
        id: { type: integer, minimum: 1 }
      required: [id]
    http:
      url: https://hacker-news.firebaseio.com/v0/item/{{input.id}}.json
    output:
      select: "{title: title, by: by, score: score, url: url, comments: descendants}"
```

What each part does:

- `input` is the JSON Schema of the arguments. The model sees it, and every call is checked against
  it before a request is made.
- `{{input.id}}` puts the argument into the URL path, percent-encoded. The host is literal: an
  argument can never change where the request goes.
- `select` is a [JMESPath](/docs/framework/select/) expression that keeps only what the model needs.
  The API's full response never reaches it.
- `readOnlyHint` tells clients the tool changes nothing.

## 2. Check it

`kervan run` loads the spec first and stops with the file, line and column of every problem. A
spec that loads prints its tool count:

```sh {check="starts" ready="Loaded hacker-news" spec="hn"}
node packages/cli/bin/kervan.js run hn.yaml --http
```

```text
Loaded hacker-news 0.1.0: 2 tool(s)
Serving hacker-news on http://127.0.0.1:3000/mcp
```

## 3. Try the tools

`kervan dev` serves the same file with a REPL in the terminal, and reloads it when you save:

```sh {check="starts" ready="Kervan dev server" spec="hn"}
node packages/cli/bin/kervan.js dev hn.yaml
```

```text {check="repl" spec="hn" network="true"}
kervan> call get_item {"id": 8863}
{"title":"My YC app: Dropbox - Throw away your USB drive","by":"dhouston","score":104,"url":"http://www.getdropbox.com/u/2/screencast.html","comments":71}
kervan> call get_item {"id": 0}
error: Input validation error: Invalid arguments for tool get_item: data/id must be >= 1
```

The second call never reached the API: the input schema refused it, and the model gets that error
to correct its arguments.

## 4. Serve it to a client

Over stdio for a local client, or over HTTP:

```sh {check="starts" ready="Serving hacker-news" spec="hn"}
node packages/cli/bin/kervan.js run hn.yaml --http
```

Then [connect it to Claude Code](/guides/connect-claude-code/) or any MCP client.

## Next

- APIs that need keys, POST bodies and query strings:
  [expose a REST API as MCP tools](/guides/rest-api-as-mcp-tools/).
- Every field: the [kervan.yaml reference](/docs/framework/spec-reference/).
