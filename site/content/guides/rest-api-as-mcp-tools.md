---
title: Expose a REST API as MCP tools
seoTitle: 'Expose a REST API as MCP tools'
description: 'Turn REST endpoints into MCP tools with Kervan: query strings, path parameters, a JSON POST body, an output schema, and API keys kept out of logs.'
lead: Three endpoints of a REST API become three MCP tools, with typed inputs, chosen outputs, and room for an API key.
weight: 30
menuTitle: 'A REST API as tools'
---

This guide uses [JSONPlaceholder](https://jsonplaceholder.typicode.com), a public test API that
needs no key and accepts writes without keeping them. The commands run in the repository folder of
a Kervan clone ([quickstart](/docs/framework/quickstart/)), with the network.

## The spec

Save this as `posts.yaml`:

```yaml {check="spec" id="posts"}
specVersion: 1
name: posts
version: 0.1.0
description: Posts and comments from a REST API (JSONPlaceholder, a public test API).
defaults:
  http: { timeoutMs: 8000 }
tools:
  - name: list_posts
    title: List posts
    description: The titles and ids of a user's posts.
    annotations: { readOnlyHint: true }
    input:
      type: object
      properties:
        userId: { type: integer, minimum: 1 }
      required: [userId]
    http:
      url: https://jsonplaceholder.typicode.com/posts
      query: { userId: "{{input.userId}}" }
    output:
      select: "[].{id: id, title: title}"
  - name: get_post
    title: Get a post
    description: One post with its body, by id.
    annotations: { readOnlyHint: true }
    input:
      type: object
      properties:
        id: { type: integer, minimum: 1 }
      required: [id]
    http:
      url: https://jsonplaceholder.typicode.com/posts/{{input.id}}
    output:
      select: "{id: id, title: title, body: body}"
      schema:
        type: object
        properties:
          id: { type: integer }
          title: { type: string }
          body: { type: string }
        required: [id, title, body]
  - name: create_post
    title: Create a post
    description: Creates a post and returns its new id. The test API does not keep it.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    input:
      type: object
      properties:
        userId: { type: integer, minimum: 1 }
        title: { type: string, minLength: 1, maxLength: 200 }
        body: { type: string, maxLength: 5000 }
      required: [userId, title, body]
    http:
      method: POST
      url: https://jsonplaceholder.typicode.com/posts
      body:
        userId: "{{input.userId}}"
        title: "{{input.title}}"
        body: "{{input.body}}"
    output:
      select: "{id: id, title: title}"
```

## How each endpoint maps

| REST | Spec |
| --- | --- |
| `GET /posts?userId=1` | `query: { userId: "{{input.userId}}" }`; an optional argument that is not given leaves the parameter out. |
| `GET /posts/1` | `{{input.id}}` in the path, percent-encoded; `.` and `..` values are refused. |
| `POST /posts` with a JSON body | `method: POST` and `body`, built as JSON, never by joining strings. `"{{input.userId}}"` alone keeps the number a number. |
| The response | `select` picks the fields; `schema` makes the result structured and validated. |

## Try it

```sh {check="starts" ready="Kervan dev server" spec="posts"}
node packages/cli/bin/kervan.js dev posts.yaml
```

```text {check="repl" spec="posts" network="true"}
kervan> call get_post {"id": 1}
{"id":1,"title":"sunt aut facere repellat provident occaecati excepturi optio reprehenderit","body":"quia et suscipit\nsuscipit recusandae consequuntur expedita et cum\nreprehenderit molestiae ut ut quas totam\nnostrum rerum est autem sunt rem eveniet architecto"}
structured: {"id":1,"title":"sunt aut facere repellat provident occaecati excepturi optio reprehenderit","body":"quia et suscipit\nsuscipit recusandae consequuntur expedita et cum\nreprehenderit molestiae ut ut quas totam\nnostrum rerum est autem sunt rem eveniet architecto"}
kervan> call create_post {"userId": 1, "title": "Hello from MCP", "body": "Created through a Kervan tool."}
{"id":101,"title":"Hello from MCP"}
```

## APIs that need a key

Most APIs need a key. Declare it and use it in a header; the value comes from the environment, and
binding it to the API's host means it can be sent nowhere else:

```yaml {check="fragment"}
secrets:
  - name: POSTS_API_KEY
    hosts: [jsonplaceholder.typicode.com]
```

```yaml {check="fragment"}
http:
  url: https://jsonplaceholder.typicode.com/posts
  headers: { Authorization: "Bearer {{secrets.POSTS_API_KEY}}" }
```

```sh {check="manual" reason="the test API needs no key; shows how one is passed"}
node packages/cli/bin/kervan.js run posts.yaml --env-file .env
```

The key is redacted from every result, error and log line, and never travels over plain http.
More in [secrets and environment variables](/docs/framework/secrets/).

## Limits worth setting

APIs with large responses or slow endpoints: `maxResponseBytes`, `timeoutMs` and
`maxOutputChars` per tool or in `defaults.http`; and a `rateLimit` per tool so a model in a loop
cannot flood the API. See [HTTP tools](/docs/framework/http-tools/#limits).
