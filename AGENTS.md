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

There are no automated tests; manual testing is done via the Extension Development Host (`F5` in VS Code, uses `.vscode/launch.json`, which runs `compile` as the pre-launch task).

**Releasing:** bump `"version"` in `package.json` and push to `main`. CI auto-packages, generates SLSA provenance, and creates a GitHub release. Publishing to the Marketplace currently requires downloading the `.vsix` from the release and uploading it manually (no `VSCE_PAT` automation).

## Architecture

The extension is three TypeScript files under `src/`, plus JSON schemas under `schemas/`.

**`mdmClient.ts`** - all CLI interaction. Shells out to the `mdm` binary (path from `mdm.cliPath` setting, default `"mdm"`) via `execFile` (no shell, so arguments are passed safely). Every call passes `cwd: workspaceRoot` (first open workspace folder) so `mdm` resolves project-scope items correctly. CLI output is requested as `--json` where the CLI offers it and validated by per-shape type guards in `assertJsonArray`; everything else is read straight from the lock files. Key methods:

- `listItems('skills')` → `mdm skills list --json` → parses JSON tolerating both `Name`/`name` capitalizations. Sets `filePath` to `Path/SKILL.md` for click-to-open, `ref` for the installed git ref, `harnesses` (the JSON key is still `Agents`, a stable CLI contract) and `plugin`.
- `listItems('harnesses')` → two calls in parallel: `mdm harnesses list --json --global` and `mdm harnesses list --json` (project). Each `MdmItem` keeps the harness's canonical CLI `name` (e.g. `claude-code`) in `cliName` and uses the human `displayName` (e.g. `Claude Code`) for `name`. Global harnesses get `filePath` → `~/.agents/mdm-state.json`; project harnesses → `{workspaceRoot}/mdm.lock`. A parallel `rulesStatus()` lookup adds a "rules not linked" description when a harness's rules file is `missing`, `broken`, or `standalone`.
- `listItems('agents')` → agent definitions. `mdm agents list` has no `--json`, so entries come from the `agents` section of `mdm.lock` (project) and `mdm-state.json` (global). `filePath` is the canonical file `.agents/agents/<name>.md` (or `.toml` when the lock records `format: toml`); a missing canonical file sets `status` so the tree can flag it and offer `mdm.installAgents`.
- `addSkill` / `removeSkill` / `updateSkill` / `updateAllSkills` / `installSkills(mode?)` / `auditSkills` / `findSkills` / `preInstallAudit` / `cherryPickSkills` - typed wrappers around the corresponding `mdm skills …` subcommands. Mutating commands always pass `-y` to skip CLI prompts. `installSkills("copy" | "symlink")` is how the project's install mode is switched (the CLI re-materializes existing installs, then records the mode).
- `addAgentDefinitions` / `updateAgentDefinition` / `updateAllAgentDefinitions` / `removeAgentDefinition` / `installAgentDefinitions` - wrappers around `mdm agents …` (`--harness`, `--agent`, `-p`/`-g`).
- `listAvailableHarnesses` / `addHarness` / `removeHarness` - wrappers around `mdm harnesses …`. `removeHarness` takes the canonical CLI name straight from `MdmItem.cliName`.
- `rulesStatus` / `rulesLink` / `rulesUnlink` - wrappers around `mdm rules …` (`--harness`).
- `readInstallModes` / `projectLockSkillCount` / `readProjectLockSections` / `detectLegacyLockFiles` / `hasPreReleaseLockFile` - direct lock-file reads. `globalStatePath()` honors `XDG_STATE_HOME` the way the CLI does.
- `runDoctor` → `mdm doctor`; `bugReportUrl` → `mdm bug --print` (last URL line); `migrate({ deleteOldFiles, force })`. Output is ANSI-stripped before display.

**`mdmTreeProvider.ts`** - three tree provider classes.

- `MdmTreeProvider` powers the **Skills**, **Agents**, and **Harnesses** panels: two-level tree with `Global` / `Project` scope headers expanding into `MdmTreeItem` leaf nodes. Skills and Agents headers show the scope's install mode (`symlink` / `copy`) as their description. `contextValue` (`mdm-skill`, `mdm-agent`, `mdm-harness`, `mdm-{skills,agents,harnesses}-scope-{global,project}`) drives the inline buttons declared in `package.json` menus. Results are cached in `_itemsPromise` and cleared on `refresh()`. If the Skills/Project header has no children but a project lock file (`mdm.lock`, or a v1 `skills-lock.json`) exists, an inline "Install configured project skills" action is rendered; an Agents scope with a missing canonical file gets a "Restore agent definitions from lock" action. `MdmLockSectionTreeProvider` powers the flat **Knowledge** and **Plugins** panels from the lock sections `MdmClient.readProjectLockSections()` returns.
- `MdmRulesTreeProvider` powers the **Rules** panel: a flat list of `linked` and `broken` entries (a broken symlink offers the inline Link action to repair it). `missing` / `standalone` entries are exposed only via the title-bar "Link Harness Rules" action. Items with a `filePath` open via the `vscode.open` command on click.

All providers debounce refresh by ~100ms and dispose their `EventEmitter` and pending timers on extension shutdown.

**`extension.ts`** - wires the six providers (`skillsProvider`, `agentsProvider`, `harnessesProvider`, `rulesProvider`, `knowledgeProvider`, `pluginsProvider`). Command surface has three layers, all converging on the same handlers: sidebar-internal `_mdm.*#sideBar` commands (hidden from the palette, wired to view buttons and context menus), public `mdm.*` palette commands (thin aliases - the internal handlers already prompt for anything a tree context would have provided), and the status-bar quick-actions hub (`mdm.menu`, a grouped QuickPick over the public commands). Views render `viewsWelcome` content when empty, keyed off the `mdm.cliMissing` / `mdm.projectLockPresent` context keys that `updateViewContexts` maintains. Long-running commands use `vscode.window.withProgress` for a notification spinner. Destructive commands show a modal confirmation before calling the client. Shared helpers (`pickScope`, `pickScopeOrAll`, `pickHarnesses`, `pickRemoteSkills`, `formatError`, `extractErrOutput`) live at the bottom of the file. `installSkillWithRetry` handles the install flow's two retryable CLI errors (`audit-blocked`, `allow-hidden-chars`) with their own confirmation prompts; the cherry-pick and migrate flows retry with `--force` after their own prompts.

On configuration change (`mdm.cliPath`) and whenever any mdm lock file changes on disk (a `FileSystemWatcher` covers `mdm.lock`, the pre-release `mdm-lock.json`, and the v1 names; a second watcher covers `.agents/agents/*.{md,toml}`), views refresh. On activation the extension checks major-version alignment with the CLI (`SUPPORTED_CLI_MAJOR`), offers to rename a pre-release `mdm-lock.json` to `mdm.lock`, and offers `mdm migrate` when v1 lock files are present.

**`schemas/`** - `mdm-lock.schema.json` and `mdm-state.schema.json`, registered through `contributes.jsonValidation`. `contributes.languages` associates the `mdm.lock` filename with the built-in `json` language. The schemas mirror the Go structs in `internal/lock` of the CLI (`ProjectLockFile`, `GlobalState`, and their entry types); keep them in sync when the lock gains a key.

## Key constraints

- Vocabulary follows the CLI: a **harness** is the AI tool (Claude Code, Cursor, …; `mdm harnesses`, `--harness`), an **agent** is an agent definition file (`mdm agents`, `--agent`). Pre-harness v2 builds called harnesses "agents"; do not reintroduce `mdm agents list --json` or `--agent` for a harness.
- `mdm harnesses list --json` prints `[]` when nothing is configured, but older builds exited non-zero on an empty project list; `listHarnesses` still parses `stdout` off the error object and falls back to `[]`.
- The harness's CLI identifier (`name`, e.g. `claude-code`) is preserved in `MdmItem.cliName`. Never re-derive it by slugifying the display name; the JSON already carries the canonical value.
- The install mode is scope-wide and only switchable through commands that install (`mdm skills install --copy|--symlink` here). `_mdm.setInstallMode#sideBar` refuses when the project lock has no skills, because under `-y` the CLI would restore (and re-mode) the global state instead.
- `mdm doctor` exits 1 when it finds an error-level issue; the report is still on `stdout` and is shown when it contains "Doctor complete".
- The `tsconfig.json` explicitly sets `"types": ["node"]`, required because the `lib` array doesn't include DOM, so TypeScript won't auto-include `@types/node`.
- `typescript` is held at `^6.0.3`. TypeScript 7 compiles this project fine, but typescript-eslint's peer range is `>=4.8.4 <6.1.0` and its plugin hard-errors on load under TS 7 ("typescript-eslint does not support TS 7.0"), so `bun run lint` fails. TS 7.0 exposes no stable programmatic API (that arrives in 7.1), so this is upstream's timeline, not ours. `.github/dependabot.yml` ignores `typescript >= 7`; remove that ignore once typescript-eslint ships TS 7 support.
- ESLint enforces the `curly` rule: all `if` bodies need braces. `@typescript-eslint/no-floating-promises` is set to `error`, so all promises must be `await`ed or explicitly discarded with `void`.
- CI runs `bun run format:check`; run `bun run format` locally before pushing if your editor doesn't format on save.
