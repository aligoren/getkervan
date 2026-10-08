---
title: Users and roles
seoTitle: Kervan Studio users and roles, admins and members
description: Kervan Studio has admins and members; what each role may do, adding users, role changes, password resets, deactivation and the last-admin rule.
lead: Two roles. Admins manage people, secrets and keys; members write, publish and test specs.
weight: 90
group: People and logs
---

{{< shot name="users" alt="The users page: four accounts with their roles, one deactivated, and an Actions menu per user." >}}

## What each role may do

| Action | Member | Admin |
| --- | --- | --- |
| Create servers, edit and save specs, validate and publish, roll back | yes | yes |
| Disable and enable a server | yes | yes |
| Use the playground, see call metadata | yes | yes |
| Delete servers | | yes |
| Manage secrets and API keys | | yes |
| See logged call arguments and results | | yes |
| Manage users, read the audit log | | yes |

The server checks every role on every request; hiding a button is never what enforces it.

## Managing users

{{< shot name="profile" alt="The profile page: the display name, the password form and the list of active sessions with their device and address." caption="Each user's own profile; admins manage everyone else from Users." >}}

Admins add users from **Users**. Adding a user, changing a role and resetting a password ask for
the admin's own password, checked by the server: a stolen session alone cannot create a new admin.

- **Role change:** the user is signed out everywhere (playground tokens too) and signs in again
  with the new role.
- **Password reset:** a temporary password, the admin's choice or a generated one shown once. The
  user is signed out and must choose a new password at the next sign-in; until then the API
  refuses everything else.
- **Deactivate:** the user is signed out at once and cannot sign in until reactivated. Studio lists
  the API keys the user created and revokes them too unless the box is unchecked. Reactivating
  does not bring revoked keys back.
- **The last active admin** cannot be deactivated or made a member.
- Users are never deleted, so the [audit log](/docs/studio/audit/) keeps pointing at them.

## Names and emails

Emails, display names, server names and key names that others see cannot hide anything:
invisible, control and text-direction characters are refused. A display name cannot read as
"admin" or another reserved label, or as any email, in lookalike forms either.

## Sign-in protection

Five failed sign-ins for an account, or twenty from one address (per /64 for IPv6), within 15
minutes lock it for 15 minutes, even for the right password. Unknown accounts behave exactly like
known ones. Passwords are at least 12 characters and stored as scrypt hashes.
