# Security policy

## Supported versions

Security fixes land on `main`. Older commits do not receive backported fixes.
Use the Pi and Claude Code versions that `main` supports; see the [README requirements](README.md#requirements).

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/yamatakeru/pi-claude-native/security/advisories/new).
Do not disclose vulnerabilities in public issues, discussions, or pull requests before coordinated disclosure.

Include:

- A description of the vulnerability and its potential impact.
- The affected extension, Pi, Claude Code, runtime, and operating system versions.
- Minimal reproduction steps or a proof of concept that uses synthetic data.
- Any suggested mitigation, if known.

Do not include live credentials, authentication files, personal data, or private conversation content.
If a credential was exposed, revoke or rotate it immediately. Removing it from a report does not make it safe again.

Reports should concern this extension or its handling of data, processes, tools, and authentication boundaries.
For vulnerabilities confined to Pi, Claude Code, or another dependency, use that project's security reporting process.
If the extension's involvement is unclear, explain the uncertainty in the private report.

The maintainer reviews reports as availability permits. This project does not promise a response deadline or a bug bounty.
