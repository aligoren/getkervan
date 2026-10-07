// End to end against a real Studio and a real browser: setup, servers, users (add, role change,
// last-admin protection, password reset), the forced password change, the profile, the theme
// following the account, the layout at 1100px, and no sideways scrolling at 390px.
import { type Browser, expect, type Page, test } from "@playwright/test"
import { launchStudio, type RunningStudio, testPassword } from "./studio.js"

test.describe.configure({ mode: "serial" })

let studio: RunningStudio
const admin = { email: "admin@e2e.test", password: testPassword() }
const member = { email: "member@e2e.test", password: testPassword() }
let serverPath = ""

test.beforeAll(async () => {
  studio = await launchStudio()
})
test.afterAll(async () => {
  await studio?.stop()
})

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto(studio.url)
  await page.getByLabel("Email").fill(who.email)
  await page.getByLabel("Password").fill(who.password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

async function newPage(browser: Browser, width = 1280, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } })
  return context.newPage()
}

const themeOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null)

async function expectNoSidewaysScroll(page: Page, what: string) {
  const sizes = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }))
  expect(
    sizes.scroll,
    `${what}: page is ${sizes.scroll}px wide in ${sizes.viewport}px`,
  ).toBeLessThanOrEqual(sizes.viewport)
}

const rowActions = (page: Page, email: string) =>
  page.getByRole("button", { name: `Actions for ${email}` })

test("setup creates the first admin with the console's token", async ({ page }) => {
  await page.goto(`${studio.url}/setup`)
  await expect(
    page.getByRole("heading", { name: "Set up Kervan Studio", exact: true }),
  ).toBeVisible()
  await page.getByLabel("Setup token").fill(studio.setupToken)
  await page.getByLabel("Email").fill(admin.email)
  await page.getByLabel("Password").fill(admin.password)
  await page.getByRole("button", { name: "Create admin" }).click()
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible()
  await expect(page.getByText("No servers yet")).toBeVisible()
  // The console printed /setup; the address no longer says so.
  expect(new URL(page.url()).pathname).toBe("/")
})

test("a new server's slug follows its name until it is edited", async ({ browser }) => {
  const page = await newPage(browser)
  await signIn(page, admin)
  await page.getByRole("button", { name: "Create server" }).click()
  const dialog = page.getByRole("dialog", { name: "Create server" })
  await dialog.getByLabel("Name").fill("Hava Durumu İzmir")
  await expect(dialog.getByLabel("Slug")).toHaveValue("hava-durumu-izmir")
  await dialog.getByLabel("Slug").fill("weather")
  await dialog.getByLabel("Name").fill("Weather")
  await expect(dialog.getByLabel("Slug")).toHaveValue("weather")
  await dialog.getByRole("button", { name: "Create server" }).click()
  await expect(page.getByRole("heading", { name: "Weather", exact: true })).toBeVisible()
  serverPath = new URL(page.url()).hash
  expect(serverPath).toMatch(/^#\/servers\//)
})

test("the editor and the playground never overlap", async ({ browser }) => {
  for (const width of [1100, 1280, 1440]) {
    const page = await newPage(browser, width)
    await signIn(page, admin)
    await page.goto(`${studio.url}/${serverPath}`)
    const editor = page.getByTestId("spec-editor")
    const playground = page.getByRole("heading", { name: "Playground", exact: true })
    await expect(editor).toBeVisible()
    await expect(playground).toBeVisible()
    const a = await editor.boundingBox()
    const b = await page.getByTestId("playground").boundingBox()
    if (!a || !b) throw new Error("no layout")
    const apart = b.x >= a.x + a.width || b.y >= a.y + a.height
    expect(apart, `at ${width}px the playground overlaps the editor`).toBe(true)
    await expectNoSidewaysScroll(page, `server page at ${width}px`)
    await page.context().close()
  }
})

test("the last active admin can neither stop being admin nor be deactivated", async ({
  browser,
}) => {
  const page = await newPage(browser)
  await signIn(page, admin)
  await page.goto(`${studio.url}/#/users`)
  await rowActions(page, admin.email).click()
  await page.getByRole("menuitem", { name: "Change role" }).click()
  let dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("combobox", { name: "Role" })).toHaveText("member")
  await dialog.getByLabel("Your password, to confirm").fill(admin.password)
  await dialog.getByRole("button", { name: "Make member" }).click()
  await expect(dialog.getByRole("alert")).toHaveText(
    "The last active admin cannot stop being an admin.",
  )
  await dialog.getByRole("button", { name: "Cancel" }).click()

  await rowActions(page, admin.email).click()
  await page.getByRole("menuitem", { name: "Deactivate" }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Deactivate" }).click()
  await expect(dialog.getByRole("alert")).toHaveText("The last active admin cannot be deactivated.")
})

test("users: add a member, then change a role only with confirmation and the admin's password", async ({
  browser,
}) => {
  const page = await newPage(browser)
  await signIn(page, admin)
  await page.goto(`${studio.url}/#/users`)
  await page.getByRole("button", { name: "Add user" }).click()
  let dialog = page.getByRole("dialog", { name: "Add user" })
  await dialog.getByLabel("Email").fill(member.email)
  await dialog.getByLabel("Initial password").fill(member.password)
  await expect(dialog.getByRole("combobox", { name: "Role" })).toHaveText("member")
  await dialog.getByRole("button", { name: "Add user" }).click()
  const row = page.getByRole("row").filter({ hasText: member.email })
  await expect(row).toContainText("member")
  await expect(row).toContainText("never")

  await rowActions(page, member.email).click()
  await page.getByRole("menuitem", { name: "Change role" }).click()
  dialog = page.getByRole("dialog")
  await expect(dialog).toContainText(`Make ${member.email} an admin?`)
  await dialog.getByLabel("Your password, to confirm").fill("not the admin password")
  await dialog.getByRole("button", { name: "Make admin" }).click()
  // Refused: the dialog stays open with the reason, and nothing changed.
  await expect(dialog.getByRole("alert")).toHaveText("Your password is wrong.")
  await dialog.getByLabel("Your password, to confirm").fill(admin.password)
  await dialog.getByRole("button", { name: "Make admin" }).click()
  await expect(dialog).toBeHidden()
  await expect(row.getByRole("cell").nth(1)).toHaveText("admin")

  // And back, with the keyboard: the role is a design-system select.
  await rowActions(page, member.email).click()
  await page.getByRole("menuitem", { name: "Change role" }).click()
  dialog = page.getByRole("dialog")
  const role = dialog.getByRole("combobox", { name: "Role" })
  await role.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("option", { name: "member" }).press("Enter")
  await expect(role).toHaveText("member")
  await dialog.getByLabel("Your password, to confirm").fill(admin.password)
  await dialog.getByRole("button", { name: "Make member" }).click()
  await expect(dialog).toBeHidden()
  await expect(row.getByRole("cell").nth(1)).toHaveText("member")
})

let temporary = ""

test("an admin reset shows a temporary password once", async ({ browser }) => {
  const page = await newPage(browser)
  await signIn(page, admin)
  await page.goto(`${studio.url}/#/users`)
  await rowActions(page, member.email).click()
  await page.getByRole("menuitem", { name: "Reset password" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Your password, to confirm").fill(admin.password)
  await dialog.getByRole("button", { name: "Reset password" }).click()
  const shown = page
    .getByRole("dialog", { name: "Password reset" })
    .getByLabel("Temporary password")
  temporary = await shown.inputValue()
  expect(temporary.length).toBeGreaterThanOrEqual(12)
  await page.getByRole("button", { name: "Done" }).click()
  await expect(page.getByRole("row").filter({ hasText: member.email })).toContainText(
    "must change password",
  )
})

test("after a reset, nothing but the password change works, in the page and in the API", async ({
  browser,
}) => {
  const page = await newPage(browser, 390, 844)
  await signIn(page, { email: member.email, password: temporary })
  await expect(
    page.getByRole("heading", { name: "Choose a new password", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0)
  await expectNoSidewaysScroll(page, "forced password change at 390px")
  // The API refuses everything else for this session, not only the page.
  const refused = await page.request.get(`${studio.url}/api/servers`)
  expect(refused.status()).toBe(403)
  expect(await refused.json()).toMatchObject({ code: "password_change_required" })

  member.password = testPassword()
  await page.getByLabel("Current password").fill(temporary)
  await page.getByLabel("New password", { exact: true }).fill(member.password)
  await page.getByLabel("Repeat the new password").fill(member.password)
  await page.getByRole("button", { name: "Change password" }).click()
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible()
  expect((await page.request.get(`${studio.url}/api/servers`)).status()).toBe(200)
})

test("the profile: name, password change and other sessions", async ({ browser }) => {
  const other = await newPage(browser)
  await signIn(other, member)
  await expect(other.getByRole("heading", { name: "Servers", exact: true })).toBeVisible()

  const page = await newPage(browser)
  await signIn(page, member)
  await page.goto(`${studio.url}/#/profile`)
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible()
  await page.getByLabel("Display name").fill("Deniz Member")
  await page.getByRole("button", { name: "Save name" }).click()
  await expect(page.getByRole("status")).toContainText("Name saved.")
  await expect(page.getByRole("navigation", { name: "Main" }).locator("..")).toContainText(
    "Deniz Member",
  )
  const sessions = page.getByRole("list", { name: "Sessions" })
  await expect(sessions).toContainText("this session")
  expect(await sessions.getByRole("listitem").count()).toBeGreaterThanOrEqual(2)

  const next = testPassword()
  await page.getByLabel("Current password").fill(member.password)
  await page.getByLabel("New password", { exact: true }).fill(next)
  await page.getByLabel("Repeat the new password").fill(next)
  await page.getByRole("button", { name: "Change password" }).click()
  await expect(page.getByRole("status")).toContainText(
    /[1-9]\d* other session\(s\) were signed out/,
  )
  member.password = next
  await expect(sessions.getByRole("listitem")).toHaveCount(1)
  // The other browser is back at sign-in on its next request.
  await other.reload()
  await expect(other.getByRole("button", { name: "Sign in" })).toBeVisible()
})

test("the theme follows the account across sessions; signed out, the system's", async ({
  browser,
}) => {
  const page = await newPage(browser)
  await signIn(page, admin)
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible()
  expect(await themeOf(page)).toBeNull()
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click()
  expect(await themeOf(page)).toBe("dark")

  // Another browser (another device): the choice comes with the session.
  const elsewhere = await newPage(browser)
  await signIn(elsewhere, admin)
  await expect(elsewhere.getByRole("heading", { name: "Servers", exact: true })).toBeVisible()
  expect(await themeOf(elsewhere)).toBe("dark")
  // Another user is not affected.
  const theirs = await newPage(browser)
  await signIn(theirs, member)
  await expect(theirs.getByRole("heading", { name: "Servers", exact: true })).toBeVisible()
  expect(await themeOf(theirs)).toBeNull()
  // Signed out: the system theme again.
  await elsewhere.getByRole("button", { name: "Sign out" }).click()
  await expect(elsewhere.getByRole("button", { name: "Sign in" })).toBeVisible()
  expect(await themeOf(elsewhere)).toBeNull()

  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click()
  await expect
    .poll(async () => (await page.request.get(`${studio.url}/api/profile`)).json())
    .toMatchObject({
      user: { theme: "system" },
    })
})

test("at 390px every page fits the screen and the menu opens in a drawer", async ({ browser }) => {
  const page = await newPage(browser, 390, 844)
  await page.goto(studio.url)
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  await expectNoSidewaysScroll(page, "sign-in")
  await signIn(page, admin)
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible()

  for (const [hash, heading] of [
    ["#/", "Servers"],
    [serverPath, "Weather"],
    ["#/users", "Users"],
    ["#/audit", "Audit log"],
    ["#/settings", "Settings"],
    ["#/profile", "Profile"],
  ] as const) {
    await page.goto(`${studio.url}/${hash}`)
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expectNoSidewaysScroll(page, hash)
  }
  // Every tab of the server page, too.
  await page.goto(`${studio.url}/${serverPath}`)
  for (const tab of ["Editor", "Versions", "Secrets", "API keys", "Calls"]) {
    await page.getByRole("tab", { name: tab }).click()
    await expectNoSidewaysScroll(page, `server tab ${tab}`)
  }
  // Tables scroll inside their box instead.
  await page.goto(`${studio.url}/#/users`)
  await expect(page.getByRole("table", { name: "Users" })).toBeVisible()
  await expectNoSidewaysScroll(page, "users table")

  // The widest table (the audit log) scrolls sideways inside its own box, so no column is lost.
  await page.goto(`${studio.url}/#/audit`)
  const audit = page.getByRole("table", { name: "Audit log" })
  await expect(audit).toBeVisible()
  const scrolled = await audit.evaluate((table) => {
    const box = table.parentElement as HTMLElement
    box.scrollLeft = box.scrollWidth
    return {
      wider: box.scrollWidth > box.clientWidth,
      // A person can scroll it (not only a script): the box scrolls, it does not clip.
      scrollable: ["auto", "scroll"].includes(getComputedStyle(box).overflowX),
      moved: box.scrollLeft > 0,
    }
  })
  expect(scrolled).toEqual({ wider: true, scrollable: true, moved: true })
  await expect(page.getByRole("columnheader", { name: "Details" })).toBeInViewport()
  await expectNoSidewaysScroll(page, "audit table scrolled")

  // Navigation: the drawer.
  await page.getByRole("button", { name: "Open the menu" }).click()
  const drawer = page.getByRole("dialog")
  await drawer.getByRole("link", { name: "Audit log" }).click()
  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toBeVisible()
  await expect(drawer).toBeHidden()
})
