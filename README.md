# MDM VS Code Extension

A Visual Studio Code extension that surfaces your [MDM CLI](https://github.com/sethcarney/mdm) data directly in the sidebar.

Manage your markdown-driven Skills, Agent definitions, Harnesses, Rules, Knowledge bundles, and Plugins through the VS Code UI, with MDM running under the hood.

[![VS Marketplace Version](https://vsmarketplacebadges.dev/version/SethsSoftware.mdm-sidebar.svg)](https://marketplace.visualstudio.com/items?itemName=SethsSoftware.mdm-sidebar)
[![VS Marketplace Installs](https://vsmarketplacebadges.dev/installs/SethsSoftware.mdm-sidebar.svg)](https://marketplace.visualstudio.com/items?itemName=SethsSoftware.mdm-sidebar)
[![VS Marketplace Rating](https://vsmarketplacebadges.dev/rating/SethsSoftware.mdm-sidebar.svg)](https://marketplace.visualstudio.com/items?itemName=SethsSoftware.mdm-sidebar)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg)](LICENSE)
[![CI](https://github.com/sethcarney/mdm-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/sethcarney/mdm-vscode/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/sethcarney/mdm-vscode/badge)](https://securityscorecards.dev/viewer/?uri=github.com/sethcarney/mdm-vscode)

## Features

- **Activity Bar icon** - dedicated MDM panel in the left sidebar
- **Six collapsible sections**: Skills · Agents · Harnesses · Rules · Knowledge · Plugins
- **Skill management** - find, install, update, audit, and remove skills without leaving the editor; tooltips show which harnesses a skill is installed to and which plugin owns it
- **Cherry-pick (fork) skills** - fork third-party skills into `./skills` as your own (`mdm skills cherry-pick`), optionally installing the forks, with a replace prompt when a fork already exists
- **Install mode** - each scope header shows whether it installs by `symlink` (default) or `copy`; switch the project between the two from the header's context menu (`mdm skills install --copy|--symlink`)
- **Agent definitions** - browse the subagent persona files (`mdm agents`) recorded in `mdm.lock` and the global state, per scope; add from a repo or path with a harness picker, update, remove, and restore; a definition whose canonical file is missing is flagged with a one-click restore
- **Harness management** - add and remove configured harnesses (`mdm harnesses`, the AI tools mdm installs into) per scope; marks harnesses detected on this machine and warns when a harness's rules file isn't linked
- **Rules management** - link / unlink harness rule files to `AGENTS.md` from the sidebar; broken symlinks are shown with a one-click re-link
- **Knowledge bundles** - browse, update, and remove OKF bundles recorded in `mdm.lock`
- **Plugins** - browse, update, and remove Agent Plugins, with an optional data purge on removal
- **`mdm.lock` as JSON** - the lock file opens with JSON syntax highlighting and is validated against a bundled schema (hover any key for its meaning); `mdm-state.json` gets a schema too
- **v1 → v2 migration** - detects v1 lock files and offers to run `mdm migrate`, with a keep-tombstone / delete choice, a dry-run plan, and a guided `--force` step when an existing `mdm.lock` is missing entries the v1 files still hold; a pre-release `mdm-lock.json` is offered a rename to `mdm.lock`
- **Quick-actions hub** - the `MDM` status-bar button opens a menu with every command: skills, agent definitions, knowledge, plugins, harnesses, rules, restore, doctor, migration, and bug reporting
- **One-click onboarding** - `MDM: Restore Project from Lock` runs skills (which restores agent definitions too) + knowledge + plugins install in one go; empty views offer it directly
- **Doctor and bug reports** - `MDM: Doctor` shows the health report in the MDM output channel even when it exits non-zero; `MDM: Report a Bug` builds the prefilled GitHub issue form with `mdm bug --print` (nothing is sent until you submit it)
- **Welcome views** - every empty section explains itself and offers the relevant action as a button; a missing CLI shows setup guidance instead of an error row
- **Live data** - views refresh automatically when any mdm lock file or a canonical agent definition changes on disk, plus per-section refresh buttons
- **Copy name** context menu action on any item
- **Command palette parity** - every action is also a palette command under the `MDM:` category
- **Graceful error handling** - shows a clear message and settings shortcut when the CLI is not found

## Requirements

The MDM CLI must be installed and reachable in your `PATH`:

```sh
# verify
mdm --version
```

If you installed the CLI to a non-standard location, set `mdm.cliPath` in VS Code settings.

### Versioning

The extension and the CLI are **major-version aligned**: extension 2.x targets
mdm CLI 2.x. Minor and patch versions move independently on each side. The
extension checks the CLI version on activation: an older CLI gets an
`mdm upgrade` nudge, a newer CLI major prompts you to update the extension.
Dev builds of the CLI (`mdm dev`) are exempt from the check.

## Extension Settings

| Setting       | Default | Description                                                           |
| ------------- | ------- | --------------------------------------------------------------------- |
| `mdm.cliPath` | `"mdm"` | Path to the `mdm` executable. Override when the CLI is not in `PATH`. |

## CLI Commands Used

The extension drives Skills, Harnesses, and Rules through `mdm <subcommand> --json`, and reads Agent definition, Knowledge, and Plugin entries straight from `mdm.lock` and `~/.agents/mdm-state.json` (the v1 per-feature lock files are read as a pre-migration fallback). Output is validated against per-shape type guards before being rendered, so an unfamiliar CLI response surfaces as an in-tree error rather than a silent failure.

| Feature             | CLI calls                                                      |
| ------------------- | -------------------------------------------------------------- |
| Skills              | `skills list/add/remove/update/audit/find/install/cherry-pick` |
| Agent definitions   | `agents add/update/remove/install` (listing reads the lock)    |
| Harnesses           | `harnesses list [--available]/add/remove`                      |
| Rules               | `rules status/link/unlink --harness`                           |
| Knowledge / Plugins | `knowledge …`, `plugins … --harness`                           |
| Project             | `doctor`, `migrate [--force]`, `bug --print`                   |

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
