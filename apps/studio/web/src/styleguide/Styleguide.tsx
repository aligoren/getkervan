// The design system on one page (development only). Every value here is made up: no real keys,
// tokens or passwords.
import {
  Ban,
  Ellipsis,
  KeyRound,
  Mail,
  Plus,
  RotateCcw,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { type ReactNode, useState } from "react"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { Card, CardContent, CardFooter, CardHeader } from "../ui/Card.js"
import { CodeBlock, CopyButton } from "../ui/Copy.js"
import { Dialog } from "../ui/Dialog.js"
import { Checkbox, Field, Input, NativeSelect, Textarea } from "../ui/Field.js"
import { Alert, EmptyState, PageHeader, Skeleton } from "../ui/Layout.js"
import { Menu, Select, TabPanel, Tabs, Tooltip, TooltipProvider } from "../ui/Radix.js"
import { EmptyRow, Table, TBody, TD, TH, THead, TR } from "../ui/Table.js"
import { applyTheme, type ThemeChoice, ThemeToggle } from "../ui/ThemeToggle.js"
import { ToastProvider, useToast } from "../ui/Toast.js"

const SWATCHES: [string, string][] = [
  ["bg", "bg-bg"],
  ["surface", "bg-surface"],
  ["subtle", "bg-subtle"],
  ["muted", "bg-muted"],
  ["border-strong", "bg-border-strong"],
  ["fg-subtle", "bg-fg-subtle"],
  ["fg-muted", "bg-fg-muted"],
  ["fg", "bg-fg"],
  ["accent", "bg-accent"],
  ["accent-subtle", "bg-accent-subtle"],
  ["success", "bg-success"],
  ["warning", "bg-warning"],
  ["danger", "bg-danger"],
]

function Section(props: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-8 first:border-t-0 first:pt-0">
      <h2 className="text-lg font-semibold tracking-tight">{props.title}</h2>
      {props.description ? <p className="mt-1 text-sm text-fg-muted">{props.description}</p> : null}
      <div className="mt-5">{props.children}</div>
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>
}

function Demo() {
  const notify = useToast()
  const [theme, setTheme] = useState<ThemeChoice>("system")
  const [tab, setTab] = useState("editor")
  const [role, setRole] = useState("member")
  const [createOpen, setCreateOpen] = useState(false)
  const [deactivateOpen, setDeactivateOpen] = useState(false)
  const [revokeKeys, setRevokeKeys] = useState(true)
  const [loading, setLoading] = useState(false)

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
      <PageHeader
        eyebrow="Development only"
        title="Kervan Studio design system"
        description="Tokens, components and states. Light and dark come from the same semantic tokens."
        actions={
          <ThemeToggle
            value={theme}
            onChange={(choice) => {
              setTheme(choice)
              applyTheme(choice)
            }}
          />
        }
      />

      <Section title="Color" description="Semantic tokens; components never use raw colors.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {SWATCHES.map(([name, className]) => (
            <div key={name} className="overflow-hidden rounded-lg border border-border bg-surface">
              <div className={`h-12 ${className}`} />
              <div className="px-2.5 py-1.5 font-mono text-xs text-fg-muted">{name}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type" description="Inter Variable, self-hosted. Body text is 14px.">
        <div className="space-y-2">
          <p className="text-xl font-semibold tracking-tight">Page title · 22/30 semibold</p>
          <p className="text-lg font-semibold tracking-tight">Section title · 18/28 semibold</p>
          <p className="text-base font-semibold">Card title · 16/24 semibold</p>
          <p className="text-sm">Body · 14/20 regular. The quick caravan crosses the dunes.</p>
          <p className="text-sm text-fg-muted">Muted · descriptions and secondary text.</p>
          <p className="text-xs text-fg-subtle">Caption · 12/16, help text and timestamps.</p>
          <p className="font-mono text-[0.8125rem]">Mono · claude mcp add --transport http</p>
        </div>
      </Section>

      <Section
        title="Buttons"
        description="One primary action per view; danger only to confirm destructive actions."
      >
        <div className="space-y-4">
          <Row>
            <Button variant="primary" icon={<Plus className="size-4" />}>
              Create server
            </Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger" icon={<Ban className="size-4" />}>
              Deactivate
            </Button>
          </Row>
          <Row>
            <Button variant="primary" size="sm">
              Small primary
            </Button>
            <Button size="sm">Small</Button>
            <Button size="icon" variant="ghost" aria-label="More actions">
              <Ellipsis className="size-4" />
            </Button>
            <Button
              variant="primary"
              loading={loading}
              onClick={() => {
                setLoading(true)
                setTimeout(() => setLoading(false), 1500)
              }}
            >
              {loading ? "Publishing…" : "Publish"}
            </Button>
            <Button disabled>Disabled</Button>
          </Row>
        </div>
      </Section>

      <Section
        title="Form fields"
        description="Always a visible label; help text below; errors replace the help."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Slug" help="Lowercase letters, numbers and dashes.">
            <Input placeholder="weather" />
          </Field>
          <Field label="Email" error="Another user already has this email.">
            <Input type="email" defaultValue="admin@example.test" />
          </Field>
          <Field label="Display name" hint="optional">
            <Input placeholder="Ada Lovelace" />
          </Field>
          <Field label="Role">
            <NativeSelect defaultValue="member">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </NativeSelect>
          </Field>
          <Field label="Arguments (JSON)" help="Filled from the tool's input schema.">
            <Textarea
              defaultValue={'{\n  "latitude": 41.01,\n  "longitude": 28.97\n}'}
              className="font-mono"
            />
          </Field>
          <div className="flex flex-col gap-4">
            <Field label="Read-only">
              <Input readOnly value="https://studio.example.com/s/0b5c…/mcp" />
            </Field>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">Radix select</span>
              <Select
                aria-label="Role"
                value={role}
                onValueChange={setRole}
                options={[
                  { value: "member", label: "Member" },
                  { value: "admin", label: "Admin" },
                ]}
                className="w-36"
              />
            </div>
            <Checkbox
              label="Also revoke their 2 API keys"
              description="Keys belong to servers; without this they keep working."
              checked={revokeKeys}
              onChange={setRevokeKeys}
            />
          </div>
        </div>
      </Section>

      <Section title="Badges" description="Status: color plus text, never color alone.">
        <Row>
          <Badge tone="success" dot>
            Published v3
          </Badge>
          <Badge tone="danger" dot>
            Draft v4 has problems
          </Badge>
          <Badge dot>Not checked</Badge>
          <Badge tone="accent">Admin</Badge>
          <Badge tone="warning">Must change password</Badge>
          <Badge>Member</Badge>
        </Row>
      </Section>

      <Section title="Card, code and copy">
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Connect a client"
              description="Run this once in a terminal. The key is shown only when it is created."
              actions={<Badge tone="success">Active</Badge>}
            />
            <CardContent className="space-y-3">
              <CodeBlock copy label="Claude Code">
                {
                  'claude mcp add --transport http weather https://studio.example.com/s/0b5c2f1e/mcp --header "Authorization: Bearer <your API key>"'
                }
              </CodeBlock>
            </CardContent>
            <CardFooter>
              <Button>Done</Button>
              <CopyButton value="<your API key>" label="Copy key" variant="primary" />
            </CardFooter>
          </Card>
          <Card>
            <CardHeader
              title="Security"
              description="Change your password and see where you are signed in."
            />
            <CardContent className="space-y-4">
              <Alert tone="success">Password changed. 2 other sessions were signed out.</Alert>
              <Alert tone="warning" title="An admin reset your password">
                Choose your own before you continue.
              </Alert>
              <Alert tone="danger">The last active admin cannot stop being an admin.</Alert>
              <Alert>Users are deactivated, never deleted.</Alert>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section
        title="Table"
        description="Hover highlights rows; deactivated rows are muted; actions sit in a menu."
      >
        <Table aria-label="Users">
          <THead>
            <tr>
              <TH>User</TH>
              <TH>Role</TH>
              <TH>Status</TH>
              <TH>Last login</TH>
              <TH className="w-12">
                <span className="visually-hidden">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {[
              {
                email: "admin@example.test",
                name: "Ada Lovelace",
                role: "admin",
                active: true,
                login: "Oct 7, 11:21",
              },
              {
                email: "member@example.test",
                name: "",
                role: "member",
                active: true,
                login: "Oct 6, 09:02",
              },
              {
                email: "former@example.test",
                name: "",
                role: "member",
                active: false,
                login: "Sep 2, 17:40",
              },
            ].map((user) => (
              <TR key={user.email} muted={!user.active}>
                <TD>
                  <div className="font-medium">{user.email}</div>
                  {user.name ? <div className="text-xs text-fg-subtle">{user.name}</div> : null}
                </TD>
                <TD>
                  <Badge tone={user.role === "admin" ? "accent" : "neutral"}>{user.role}</Badge>
                </TD>
                <TD>
                  {user.active ? (
                    <Badge tone="success" dot>
                      Active
                    </Badge>
                  ) : (
                    <Badge dot>Deactivated</Badge>
                  )}
                </TD>
                <TD className="whitespace-nowrap text-fg-muted">{user.login}</TD>
                <TD>
                  <Menu
                    label={`Actions for ${user.email}`}
                    trigger={
                      <Button size="icon" variant="ghost">
                        <Ellipsis className="size-4" />
                      </Button>
                    }
                    items={[
                      { label: "Edit email", icon: <Mail />, onSelect: () => {} },
                      { label: "Reset password", icon: <KeyRound />, onSelect: () => {} },
                      { label: "Change role", icon: <ShieldCheck />, onSelect: () => {} },
                      "separator",
                      user.active
                        ? {
                            label: "Deactivate",
                            icon: <Ban />,
                            danger: true,
                            onSelect: () => setDeactivateOpen(true),
                          }
                        : { label: "Reactivate", icon: <RotateCcw />, onSelect: () => {} },
                    ]}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        <div className="mt-4">
          <Table dense aria-label="Calls">
            <THead>
              <tr>
                <TH>Time</TH>
                <TH>Tool</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              <EmptyRow colSpan={3}>
                No calls yet. Calls from clients and the playground show up here.
              </EmptyRow>
            </TBody>
          </Table>
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs
          aria-label="Server"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: "editor", label: "Editor" },
            { value: "versions", label: "Versions", count: 4 },
            { value: "secrets", label: "Secrets", count: 1 },
            { value: "keys", label: "API keys" },
            { value: "calls", label: "Calls" },
          ]}
        >
          <TabPanel value={tab}>
            <p className="text-sm text-fg-muted">Content of the “{tab}” tab.</p>
          </TabPanel>
        </Tabs>
      </Section>

      <Section title="Dialogs, toasts, tooltips">
        <Row>
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setCreateOpen(true)}
          >
            Create server
          </Button>
          <Button
            variant="danger"
            icon={<Ban className="size-4" />}
            onClick={() => setDeactivateOpen(true)}
          >
            Deactivate user
          </Button>
          <Button onClick={() => notify("Copied to the clipboard")}>Show a toast</Button>
          <Button onClick={() => notify("Could not save the secret.", "danger")}>
            Error toast
          </Button>
          <TooltipProvider>
            <Tooltip content="Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/154.0.0.0">
              <Button variant="ghost">Chrome 154 · Windows</Button>
            </Tooltip>
          </TooltipProvider>
        </Row>
        <Dialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          title="Create a server"
          description="A server is one MCP endpoint with its own versions, secrets and keys."
          footer={
            <>
              <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setCreateOpen(false)}>
                Create server
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Name">
              <Input placeholder="Weather" />
            </Field>
            <Field
              label="Slug"
              help="Used in names and commands. Lowercase letters, numbers and dashes."
            >
              <Input placeholder="weather" />
            </Field>
          </div>
        </Dialog>
        <Dialog
          open={deactivateOpen}
          onOpenChange={setDeactivateOpen}
          tone="danger"
          title="Deactivate member@example.test?"
          description="They are signed out at once and cannot sign in until reactivated."
          footer={
            <>
              <Button onClick={() => setDeactivateOpen(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setDeactivateOpen(false)}>
                Deactivate
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-fg-muted">API keys they created:</p>
            <ul className="space-y-1.5">
              <li className="flex items-center gap-2">
                <KeyRound className="size-4 text-fg-subtle" /> ci{" "}
                <span className="text-fg-subtle">on Weather</span>
              </li>
              <li className="flex items-center gap-2">
                <KeyRound className="size-4 text-fg-subtle" /> laptop{" "}
                <span className="text-fg-subtle">on Search</span>
              </li>
            </ul>
            <Checkbox
              label="Also revoke these 2 API keys"
              checked={revokeKeys}
              onChange={setRevokeKeys}
            />
          </div>
        </Dialog>
      </Section>

      <Section title="Empty, loading and error states">
        <div className="grid gap-5 lg:grid-cols-3">
          <EmptyState
            icon={<Server className="size-5" />}
            title="No servers yet"
            description="Create a server, write its kervan.yaml, and publish it."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />}>
                Create server
              </Button>
            }
          />
          <Card>
            <CardContent className="space-y-3">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </CardContent>
          </Card>
          <EmptyState
            icon={<Trash2 className="size-5" />}
            title="Could not load the audit log"
            description="Internal error (ref: 3f9a1c2e). Try again in a moment."
            action={<Button icon={<RotateCcw className="size-4" />}>Retry</Button>}
          />
        </div>
      </Section>
    </div>
  )
}

export function Styleguide() {
  return (
    <ToastProvider>
      <Demo />
    </ToastProvider>
  )
}
