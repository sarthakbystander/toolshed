# Security Policy

Toolshed is a collection of browser-based web tools. Because visitors run the code in their own browsers,security is a first-class concern. This page explains how to report issues,and what the project expects of contributed code.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Instead,email the maintainers privately.

- **Email:** sarthakbystander@users.noreply.github.com(or whichever private address the maintainers designate)
- **Include:**
  - The affected repository area or tool,if any
  - A description of the vulnerability,and its impact
  - Reproduction steps,or a minimal proof of concept
  - Any suggested fix,if you have one
- **Expectations:** We will acknowledge receipt within a few business days,and coordinate a fix before writing it up publicly. Please allow reasonable time before disclosure.

For low-severity,non-security issues(such as bugs,and feature requests),please use the normal issue tracker instead.

## Security principles for this project

Every contributed tool must respect these rules. They are enforced by review,and are partially machine-checked by the verification pipeline(`npm run verify`).

### Malicious JavaScript

- Tool code runs in the browser. Never obfuscate code to hide behavior,. Never include code that deliberately exfiltrates data,tracks users,or mines cryptocurrency.
- All included scripts must be committed in the repository — no loading of ad-hoc or remote scripts at runtime.

### External scripts

- Do not reference third-party scripts(such as CDNs,or remote URLs,from tool pages by default. Committing dependencies locally makes the site deterministic,auditable,and usable offline. If an external script is genuinely necessary,justify it in the PR description,and review it carefully.

### Third-party dependencies

- Keep dependencies minimal. Any dependency must have a reason to exist. Update regularly,and audit for known vulnerabilities before merging.

### Unexpected network requests

- Tools must not make hidden or surprising network requests. Any network call must be explicit,user-visible,and documented in the tool metadata(`tool.json`,with `privacy.dataUploaded` set to `true`),and the tool README. The homepage must not make network requests unless required.

### User data transmission

- Never upload user data without explicit user action,and clear documentation. Prefer processing everything locally in the browser. If a tool transmits data(such as a deliberately network-based feature),annotate it in `tool.json` privacy fields,the README,and the PR description.

### Unsafe browser APIs

- Avoid APIs that can exfiltrate data,or breakthe page sandbox,without strong justification(such as raw network sockets,or filesystem access beyond user-initiated downloads/uploads).
- Any use of such APIs must be user-driven,documented,and reviewed.

### Secrets

- Never hardcode private API keys,tokens,or credentials in frontend code,or in committed files. If a tool needs a key,require the user to supply it in the browser at runtime. Repository tooling must bear no secrets either. CI runs with the least privilege possible.

## Reporting process

1. Reporter sends a private report via email.
2. Maintainers triage,and confirm the issue.
3. Maintainers develop,and ship a fix,ideally in a private fork.
4. After the fix is deployed,or shipped,a public advisory is published,with credit where appropriate.

Thank you for helping keep Toolshed safe.