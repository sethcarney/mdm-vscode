# AGENTS.md

This file provides guidance to coding agents (Claude Code, Copilot, etc.) when working in this repository. `CLAUDE.md` and `.github/copilot-instructions.md` symlink to this file.

## Commands

```sh
bun install            # install dependencies
bun run compile        # one-shot TypeScript compile to out/
bun run watch          # watch mode (continuous compile)
bun run lint           # ESLint
bun run format         # write Prettier formatting
bun run format:check   # verify Prettier formatting (CI runs this)
bun run package        # package as .vsix
```

There are no automated tests — manual testing is done via the Extension Development Host (`F5` in VS Code, uses `.vscode/launch.json` → runs `compile` as the pre-launch task).

**Releasing:** bump `"version"` in `package.json` and push to `main`. CI auto-packages, generates SLSA provenance, and creates a GitHub release. Publishing to the Marketplace currently requires downloading the `.vsix` from the release and uploading it manually (no `VSCE_PAT` automation).

## Architecture

The extension is three TypeScript files under `src/`:

**`mdmClient.ts`** — all CLI interaction. Shells out to the `mdm` binary (path from `mdm.cliPath` setting, default `"mdm"`) via `execFile` (no shell, so arguments are passed safely). Every call passes `cwd: workspaceRoot` (first open workspace folder) so `mdm` resolves project-scope items correctly. All CLI output is requested as `--json` and validated by per-shape type guards in `assertJsonArray`. Key methods:

- `listItems('skills')` → `mdm skills list --json` → parses JSON tolerating both `Name`/`name` capitalizations. Sets `filePath` to `Path/SKILL.md` for click-to-open and `ref` for the installed git ref.
- `listItems('agents')` → two calls in parallel: `mdm agents list --json --global` and `mdm agents list --json` (project; exits non-zero when empty — caught and either parsed from `stdout` or returned as `[]`). Each `MdmItem` keeps the agent's canonical CLI `name` (e.g. `claude-code`) in `cliName` and uses the human `displayName` (e.g. `Claude Code`) for `name`. Global agents get `filePath` → `~/.agents/AGENTS.md`; project agents → `{workspaceRoot}/AGENTS.md`. A parallel `rulesStatus()` lookup adds a `⚠ rules not linked` status when an agent's rules file is missing.
- `addSkill` / `removeSkill` / `updateSkill` / `updateAllSkills` / `installSkills` / `auditSkills` / `findSkills` / `preInstallAudit` — typed wrappers around the corresponding `mdm skills …` subcommands. Mutating commands always pass `-y` to skip CLI prompts.
- `listAvailableAgents` / `addAgent` / `removeAgent` — wrappers around `mdm agents …`. `removeAgent` takes the canonical CLI name straight from `MdmItem.cliName`.
- `rulesStatus` / `rulesLink` / `rulesUnlink` — wrappers around `mdm rules …`.
- `runDoctor` → `mdm doctor`. Output is ANSI-stripped before display.

**`mdmTreeProvider.ts`** — two tree provider classes.

- `MdmTreeProvider` powers the **Skills** and **Agents** panels: two-level tree with `Global` / `Project` scope headers expanding into `MdmTreeItem` leaf nodes. `contextValue` (`mdm-skill`, `mdm-agent`, `mdm-{skills,agents}-scope-{global,project}`) drives the inline buttons declared in `package.json` menus. Results are cached in `_itemsPromise` and cleared on `refresh()`. If the Skills/Project header has no children but a `skills-lock.json` exists, an inline "Install configured project skills" action is rendered.
- `MdmRulesTreeProvider` powers the **Rules** panel: a flat list of `linked`-state entries. `missing` entries are exposed only via the title-bar "Link Agent Rules" action. Items with a `filePath` open via the `vscode.open` command on click.

Both providers debounce refresh by ~100ms and dispose their `EventEmitter` and pending timers on extension shutdown.

**`extension.ts`** — wires the three providers (`skillsProvider`, `agentsProvider`, `rulesProvider`) and a persistent status bar item (`$(pulse) MDM`) that runs `mdm.doctor` on click. Registers all commands. Long-running commands use `vscode.window.withProgress` for a notification spinner. Destructive commands show a modal confirmation before calling the client. Shared helpers (`pickScope`, `pickScopeOrAll`, `formatError`) live at the bottom of the file. `installSkillWithRetry` handles the install flow's two retryable CLI errors (`audit-blocked`, `allow-hidden-chars`) with their own confirmation prompts.

On configuration change (`mdm.cliPath`), the client's install-check cache is cleared and all three views refresh.

## Key constraints

- The `mdm agents list` command exits non-zero when no project agents are configured — the error object still carries `stdout`, which is parsed normally; if `stdout` is empty we return `[]`.
- The agent's CLI identifier (`name`, e.g. `claude-code`) is preserved in `MdmItem.cliName`. Never re-derive it by slugifying the display name — the JSON already carries the canonical value.
- The `tsconfig.json` explicitly sets `"types": ["node"]` — required because the `lib` array doesn't include DOM, so TypeScript won't auto-include `@types/node`.
- ESLint enforces the `curly` rule — all `if` bodies need braces. `@typescript-eslint/no-floating-promises` is set to `error`, so all promises must be `await`ed or explicitly discarded with `void`.
- CI runs `bun run format:check`; run `bun run format` locally before pushing if your editor doesn't format on save.
