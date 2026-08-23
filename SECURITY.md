# Security Policy

DyCAD is a static, client-side-only application — vanilla JS/HTML/CSS, no backend, no
server, no accounts, and no stored user data beyond what stays in your own browser
(`localStorage`) or a JSON file you explicitly save/load yourself. That removes most of
the usual attack surface (no auth to bypass, no server to compromise, no database to
leak), but client-side issues are still possible — most plausibly XSS via unsanitized
content in an imported file (ArchiMate XML, DDL, or a loaded JSON model) rendering
unsafely, or a vulnerability in the vendored Three.js (`js/vendor/`).

## Reporting a vulnerability

Please report it privately via GitHub's **Security** tab → **Report a vulnerability**
on this repository, rather than opening a public issue. Include the affected file/
version, steps to reproduce, and the potential impact if you can.

There's no fixed SLA — this is a small, actively-maintained personal project — but
reports will be acknowledged and addressed as soon as reasonably possible.

## Scope

- **In scope**: XSS, prototype pollution, or other client-side code-execution issues
  reachable through normal app usage (importing a file, loading a model, etc.).
- **Out of scope**: issues requiring physical/local access to a user's own machine or
  browser profile, or vulnerabilities in third-party sites linked from the Instructions
  tab.
