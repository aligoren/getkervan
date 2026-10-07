import type { User } from "../api.js"
import type { ThemeChoice } from "../theme.js"
import { Card, CardContent, CardHeader } from "../ui/Card.js"
import { CodeBlock } from "../ui/Copy.js"
import { PageHeader } from "../ui/Layout.js"
import { ThemeToggle } from "../ui/ThemeToggle.js"

/** Preferences of the signed-in user, and what clients need to know about this Studio. */
export function Settings(props: {
  user: User
  theme: ThemeChoice
  onTheme: (choice: ThemeChoice) => void
}) {
  const origin = window.location.origin
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Settings"
        description="How Studio looks for you, and how clients reach it."
      />
      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Appearance"
            description="Saved to your account, so it follows you to every device where you sign in. System follows your device's setting."
          />
          <CardContent>
            <ThemeToggle value={props.theme} onChange={props.onTheme} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Connecting clients"
            description="Every published server has its own MCP endpoint. Clients send one of that server's API keys as a bearer token."
          />
          <CardContent className="space-y-4">
            <CodeBlock label="Endpoint format">{`${origin}/s/<server id>/mcp`}</CodeBlock>
            <p className="text-sm text-fg-muted">
              {props.user.role === "admin"
                ? "Create keys on a server's Keys tab. A key works only for the server it was created for."
                : "An admin creates the API keys. A key works only for the server it was created for."}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
