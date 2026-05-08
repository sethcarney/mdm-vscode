# MDM VS Code Extension

A Visual Studio Code extension that surfaces your [MDM CLI](https://github.com/sethcarney/mdm) data — Skills, Agents, and Rules — directly in the sidebar.

[![CI](https://github.com/sethcarney/mdm-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/sethcarney/mdm-vscode/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/sethcarney/mdm-vscode/badge)](https://securityscorecards.dev/viewer/?uri=github.com/sethcarney/mdm-vscode)

## Features

- **Activity Bar icon** — dedicated MDM panel in the left sidebar
- **Three collapsible sections**: Skills · Agents · Rules
- **Live data** fetched from the MDM CLI on demand
- **Refresh button** per section to reload without restarting VS Code
- **Copy name** context menu action on any item
- **Graceful error handling** — shows a clear message and settings shortcut when the CLI is not found

## Requirements

The MDM CLI must be installed and reachable in your `PATH`:

```sh
# verify
mdm --version
```

If you installed the CLI to a non-standard location, set `mdm.cliPath` in VS Code settings.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mdm.cliPath` | `"mdm"` | Path to the `mdm` executable. Override when the CLI is not in `PATH`. |

## CLI Commands Used

The extension tries each form in order, stopping at the first success:

| View | Commands tried |
|------|----------------|
| Skills | `mdm skills list --json` → `mdm skills list` → `mdm skills` |
| Agents | `mdm agents list --json` → `mdm agents list` → `mdm agents` |
| Rules  | `mdm rules list --json`  → `mdm rules list`  → `mdm rules`  |

Both **JSON** and **plain-text** output are supported. JSON items may contain `name`/`id`/`title`/`slug` and an optional `description` field.

## Development

Requires [Bun](https://bun.sh) ≥ 1.x.

```sh
git clone https://github.com/sethcarney/mdm-vscode.git
cd mdm-vscode
bun install
bun run compile
```

Press `F5` in VS Code to open the Extension Development Host with the extension loaded.

### Scripts

| Command | Description |
|---------|-------------|
| `bun run compile` | Compile TypeScript to `out/` |
| `bun run watch` | Watch mode |
| `bun run lint` | Run ESLint |
| `bun run package` | Package as `.vsix` |

### Releasing

Bump the version in `package.json` and push to `main`:

```sh
# edit package.json: "version": "0.2.0"
git commit -am "chore: release v0.2.0"
git push origin main
```

The release workflow detects the new version, packages the extension, generates SLSA provenance, and creates a GitHub release. If the `VSCE_PAT` secret is set, it also publishes to the VS Code Marketplace.

## License

[Apache-2.0](LICENSE)
