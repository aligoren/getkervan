---
title: Profile, sessions and theme
seoTitle: Kervan Studio profile, password, sessions and theme
description: Each Kervan Studio user's profile; the display name, changing the password, the list of active sessions to sign out, and a light, dark or system theme.
lead: 'Your own account: a display name, your password, where you are signed in, and the theme.'
weight: 95
group: People and logs
menuTitle: 'Profile and sessions'
---

{{< shot name="profile" alt="The profile page: email and role, the display name, the password form and two active sessions with their device and address." >}}

- **Email and role** are shown; only an admin changes them.
- **Display name** (optional): what others see instead of your email. It cannot hide characters,
  read as a reserved label such as "admin", or read as an email.
- **Password:** the current one is required. Your other sessions are signed out, and this one goes
  on under a new session id, so an old copy of its cookie stops working.
- **Sessions:** every session with its device and address; sign them out one by one or all others
  at once.
- **Theme:** System, Light or Dark, from the sidebar or Settings. It is saved to your account, so it
  follows you to every device.

Sessions end after 2 hours without activity and after 24 hours in any case. The session cookie is
HttpOnly and SameSite=Lax, and over https also `Secure` with the `__Host-` prefix.
