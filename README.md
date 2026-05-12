# MDM VS Code Extension

A Visual Studio Code extension that surfaces your [MDM CLI](https://github.com/sethcarney/mdm) data directly in the sidebar.

Manage your markdown-driven Skills, Agents, and Rules through the VS Code UI, with MDM running under the hood.

[![VS Marketplace Version](https://vsmarketplacebadges.dev/version/SethsSoftware.mdm-sidebar.svg)](https://marketplace.visualstudio.com/items?itemName=SethsSoftware.mdm-sidebar)
[![VS Marketplace Installs](https://vsmarketplacebadges.dev/installs/SethsSoftware.mdm-sidebar.svg)](https://marketplace.visualstudio.com/items?itemName=SethsSoftware.mdm-sidebar)
[![VS Marketplace Rating](https://vsmarketplacebadges.dev/rating/SethsSoftware.mdm-sidebar.svg)](https://marketplace.visualstudio.com/items?itemName=SethsSoftware.mdm-sidebar)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg)](LICENSE)
[![CI](https://github.com/sethcarney/mdm-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/sethcarney/mdm-vscode/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/sethcarney/mdm-vscode/badge)](https://securityscorecards.dev/viewer/?uri=github.com/sethcarney/mdm-vscode)

## Features

- **Activity Bar icon** - dedicated MDM panel in the left sidebar
- **Three collapsible sections**: Skills · Agents · Rules — each grouped by Global / Project scope
- **Skill management** - find, install, update, audit, and remove skills without leaving the editor
- **Agent management** - add and remove configured agents per scope; warns when an agent's rules file isn't linked
- **Rules management** - link / unlink agent rule files to `AGENTS.md` from the sidebar
- **Doctor in the status bar** - one-click `$(pulse) MDM` button to run `mdm doctor` and stream output to a channel
- **Live data** fetched from the MDM CLI on demand; per-section refresh button reloads without restarting VS Code
- **Copy name** context menu action on any item
- **Graceful error handling** - shows a clear message and settings shortcut when the CLI is not found

## Requirements

The MDM CLI must be installed and reachable in your `PATH`:

```sh
# verify
mdm --version
```

If you installed the CLI to a non-standard location, set `mdm.cliPath` in VS Code settings.

## Extension Settings

| Setting       | Default | Description                                                           |
| ------------- | ------- | --------------------------------------------------------------------- |
| `mdm.cliPath` | `"mdm"` | Path to the `mdm` executable. Override when the CLI is not in `PATH`. |

## CLI Commands Used

The extension drives Skills, Agents, and Rules entirely through `mdm <subcommand> --json`. Output is validated against per-shape type guards before being rendered, so an unfamiliar CLI response surfaces as an in-tree error rather than a silent failure.

Implementation details are documented in [AGENTS.md](AGENTS.md).

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

| Command                | Description                               |
| ---------------------- | ----------------------------------------- |
| `bun run compile`      | Compile TypeScript to `out/`              |
| `bun run watch`        | Watch mode                                |
| `bun run lint`         | Run ESLint                                |
| `bun run format`       | Apply Prettier formatting                 |
| `bun run format:check` | Verify Prettier formatting (CI runs this) |
| `bun run package`      | Package as `.vsix`                        |

### Releasing

Bump the version in `package.json` and push to `main`:

```sh
# edit package.json: "version": "1.2.0"
git commit -am "chore: release v1.2.0"
git push origin main
```

The release workflow detects the new version, packages the extension, generates SLSA provenance, and creates a GitHub release with the `.vsix` attached. Download the `.vsix` from the release and upload it manually to the VS Code Marketplace.

## License

[Apache-2.0](LICENSE)
