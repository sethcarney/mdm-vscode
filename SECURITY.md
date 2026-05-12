# Security Policy

## Supported Versions

Only the latest released version receives security fixes. Please update before reporting issues.

| Version  | Supported          |
| -------- | ------------------ |
| latest   | :white_check_mark: |
| previous | :x:                |

## Reporting a Vulnerability

We take security vulnerabilities seriously. Please follow responsible disclosure practices and **do not report security issues through public GitHub issues**.

### How to Report

Use [GitHub Security Advisories](https://github.com/sethcarney/mdm-vscode/security/advisories/new) to create a private advisory — this is the preferred method as it keeps the report confidential and allows coordinated disclosure.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any suggested mitigations or patches

### Response Timeline

- **Acknowledgment**: within 48 hours
- **Status update**: within 7 days
- **Resolution or workaround**: within 30 days for critical issues, 90 days for others

Security researchers who responsibly disclose valid vulnerabilities will be credited in the release notes.

## Scope

This extension is a thin VS Code UI wrapper around the MDM CLI. If a vulnerability relates to the CLI itself rather than this extension, please report it in the [mdm repository](https://github.com/sethcarney/mdm).
