# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue.

Use GitHub's private vulnerability reporting for this repository
(Security tab > Report a vulnerability). Include what the issue is, which
package and version it affects, and steps to reproduce.

We aim to acknowledge reports within a few business days.

## Scope

In scope: the SDKs and examples in this repository.

Out of scope here: the hosted Swalvo platform (control plane, signaling,
media, dashboard). Report platform issues the same way and we will route them.

## Using the SDKs safely

- Never put an API key in browser, mobile or other client code. Mint a
  short-lived token on your server with `@swalvo/server` (or the Python, Go,
  Java or PHP server SDKs) and hand only the token to the client.
- Keep tokens short-lived and scoped to one room or conversation.
- Pin SDK versions and review changelogs when upgrading.
