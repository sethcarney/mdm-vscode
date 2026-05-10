# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install          # install dependencies
bun run compile      # one-shot TypeScript compile to out/
bun run watch        # watch mode (continuous compile)
bun run lint         # ESLint
bun run package      # package as .vsix
```

There are no automated tests — manual testing is done via the Extension Development Host (`F5` in VS Code, uses `.vscode/launch.json` → runs `compile` as the pre-launch task).

**Releasing:** bump `"version"` in `package.json` and push to `main`. CI auto-packages, generates SLSA provenance, and creates a GitHub release. Publishing to the Marketplace requires the `VSCE_PAT` secret to be set.

## Architecture

The extension is three TypeScript files under `src/`:

**`mdmClient.ts`** — all CLI interaction. Shells out to the `mdm` binary (path from `mdm.cliPath` setting, default `"mdm"`). Every `execAsync` call passes `cwd: workspaceRoot` (first open workspace folder) so that `mdm` resolves project-scope items correctly. Key methods:

- `listItems('skills')` → `mdm skills list --json` → parses JSON with capitalized keys (`Name`, `Description`, `Scope`, `Path`). Sets `filePath` to `Path/SKILL.md` for click-to-open.
- `listItems('agents')` → two calls: `mdm agents list --json --global` and `mdm agents list --json` (project; exits non-zero when empty, caught). Parses JSON. Global agents get `filePath` → `~/.agents/AGENTS.md`; project agents → `{workspaceRoot}/AGENTS.md`.
- `removeSkill` / `updateSkill` / `removeAgent` — thin wrappers with `-y` to skip CLI prompts.

**`mdmTreeProvider.ts`** — two tree provider classes. `MdmTreeProvider` serves the Skills and Agents panels: two-level tree with `Global` / `Project` scope headers collapsing into `MdmTreeItem` leaf nodes; `contextValue` `'mdm-skill'` or `'mdm-agent'` drives the inline buttons declared in `package.json` menus; results cached in `_itemsPromise` and cleared on `refresh()`. `MdmRulesTreeProvider` serves the Rules panel: flat list of linked-only `MdmRulesItem` entries. Items with a `filePath` open the file on click via `vscode.open`.

**`extension.ts`** — wires three providers (`skillsProvider` / `agentsProvider` as `MdmTreeProvider`; `rulesProvider` as `MdmRulesTreeProvider`) and a persistent status bar item (`$(pulse) MDM`) that runs `mdm.doctor` on click. Registers all commands. Delete commands show a modal confirmation before calling `MdmClient`, then call `provider.refresh()`. Long-running commands use `vscode.window.withProgress` for a notification spinner.

## Key constraints

- The `mdm agents list` command exits non-zero when no project agents are configured — the error object still carries `stdout`, which is parsed normally.
- Agent display names ("Claude Code") are slugified (`toLowerCase().replace(/\s+/g, '-')`) to produce the CLI argument for `mdm agents remove`.
- The `tsconfig.json` explicitly sets `"types": ["node"]` — required because the `lib` array doesn't include DOM, so TypeScript won't auto-include `@types/node`.
- ESLint enforces the `curly` rule — all `if` bodies need braces.
