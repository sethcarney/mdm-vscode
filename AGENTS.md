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

**`mdmClient.ts`** - all CLI interaction. Shells out to the `mdm` binary (path from `mdm.cliPath` setting, default `"mdm"`) via `execFile` (no shell, so arguments are passed safely). Every call passes `cwd: workspaceRoot` (first open workspace folder) so `mdm` resolves project-scope items correctly. All listing goes through the CLI's `--json` output, validated by per-shape type guards in `assertJsonArray`. The lock files are read only for things no command reports: the install mode, the project skill count, and the presence of v1 lock files. Key methods:

- `listItems('skills')` → `mdm skills list --json` → parses JSON tolerating both `Name`/`name` capitalizations. Sets `filePath` to `Path/SKILL.md` for click-to-open, `ref` for the installed git ref, `harnesses` (the JSON key is still `Agents`, a stable CLI contract) and `plugin`.
- `listItems('harnesses')` → two calls in parallel: `mdm harnesses list --json --global` and `mdm harnesses list --json` (project). Each `MdmItem` keeps the harness's canonical CLI `name` (e.g. `claude-code`) in `cliName` and uses the human `displayName` (e.g. `Claude Code`) for `name`. Global harnesses get `filePath` → `~/.agents/mdm-state.json`; project harnesses → `{workspaceRoot}/mdm.lock`. A parallel `rulesStatus()` lookup adds a "rules not linked" description when a harness's rules file is `missing`, `broken`, or `standalone`.
- `listItems('agents')` → `mdm agents list --json`. One call covers both scopes; the CLI flattens them with `scope` on each entry, like `skills list --json`. `status` comes from the CLI's disk checks: `canonicalMissing` → "file missing", an empty `installedIn` → "not installed in any harness", a non-empty `missingFrom` → "missing from <harnesses>". The JSON carries no path, so `filePath` probes `.agents/agents/<name>.md` then `.toml`, falling back to the markdown name.
- `addSkill` / `removeSkill` / `updateSkill` / `updateAllSkills` / `installSkills(mode?)` / `auditSkills` / `findSkills` / `preInstallAudit` / `cherryPickSkills` - typed wrappers around the corresponding `mdm skills …` subcommands. Mutating commands always pass `-y` to skip CLI prompts. `installSkills("copy" | "symlink")` is how the project's install mode is switched (the CLI re-materializes existing installs, then records the mode).
- `addAgentDefinitions` / `updateAgentDefinition` / `updateAllAgentDefinitions` / `removeAgentDefinition` / `installAgentDefinitions` - wrappers around `mdm agents …` (`--harness`, `--agent`, `-p`/`-g`).
- `listAvailableHarnesses` / `addHarness` / `removeHarness` - wrappers around `mdm harnesses …`. `removeHarness` takes the canonical CLI name straight from `MdmItem.cliName`.
- `rulesStatus` / `rulesLink` / `rulesUnlink` - wrappers around `mdm rules …` (`--harness`).
- `listPlugins` / `listKnowledge` / `listSection` → `mdm {plugins,knowledge} list --json`. These carry health fields the lock cannot give: `valid` and `mcpServers` for plugins, `present` and `documents` for knowledge, all of them disk checks the CLI performs.
- `readInstallModes` / `projectLockSkillCount` / `detectLegacyLockFiles` - the only remaining direct lock reads. `globalStatePath()` honors `XDG_STATE_HOME` the way the CLI does.
- `runDoctor` → `mdm doctor`; `bugReportUrl` → `mdm bug --print` (last URL line); `migrate({ deleteOldFiles, force })`. Output is ANSI-stripped before display.

**`mdmTreeProvider.ts`** - three tree provider classes.

- `MdmTreeProvider` powers the **Skills**, **Agents**, and **Harnesses** panels: two-level tree with `Global` / `Project` scope headers expanding into `MdmTreeItem` leaf nodes. Skills and Agents headers show the scope's install mode (`symlink` / `copy`) as their description. `contextValue` (`mdm-skill`, `mdm-agent`, `mdm-harness`, `mdm-{skills,agents,harnesses}-scope-{global,project}`) drives the inline buttons declared in `package.json` menus. Results are cached in `_itemsPromise` and cleared on `refresh()`. If the Skills/Project header has no children but `mdm.lock` exists, an inline "Install configured project skills" action is rendered; an Agents scope with a missing canonical file gets a "Restore agent definitions from lock" action. `MdmLockSectionTreeProvider` powers the flat **Knowledge** and **Plugins** panels from `MdmClient.listSection()`. An entry the CLI reports as `valid: false` or `present: false` gets an error-coloured warning icon and the reason in its description.
- `MdmRulesTreeProvider` powers the **Rules** panel: a flat list of `linked` and `broken` entries (a broken symlink offers the inline Link action to repair it). `missing` / `standalone` entries are exposed only via the title-bar "Link Harness Rules" action. Items with a `filePath` open via the `vscode.open` command on click.

All providers debounce refresh by ~100ms and dispose their `EventEmitter` and pending timers on extension shutdown.

**`extension.ts`** - wires the six providers (`skillsProvider`, `agentsProvider`, `harnessesProvider`, `rulesProvider`, `knowledgeProvider`, `pluginsProvider`). Command surface has three layers, all converging on the same handlers: sidebar-internal `_mdm.*#sideBar` commands (hidden from the palette, wired to view buttons and context menus), public `mdm.*` palette commands (thin aliases - the internal handlers already prompt for anything a tree context would have provided), and the status-bar quick-actions hub (`mdm.menu`, a grouped QuickPick over the public commands). Views render `viewsWelcome` content when empty, keyed off the `mdm.cliMissing` / `mdm.projectLockPresent` context keys that `updateViewContexts` maintains. Long-running commands use `vscode.window.withProgress` for a notification spinner. Destructive commands show a modal confirmation before calling the client. Shared helpers (`pickScope`, `pickScopeOrAll`, `pickHarnesses`, `pickRemoteSkills`, `formatError`, `extractErrOutput`) live at the bottom of the file. `installSkillWithRetry` handles the install flow's two retryable CLI errors (`audit-blocked`, `allow-hidden-chars`) with their own confirmation prompts; the cherry-pick and migrate flows retry with `--force` after their own prompts.

On configuration change (`mdm.cliPath`) and whenever an mdm lock file changes on disk (a `FileSystemWatcher` covers `mdm.lock` and the v1 names; a second watcher covers `.agents/agents/*.{md,toml}`), views refresh. On activation the extension checks major-version alignment with the CLI (`SUPPORTED_CLI_MAJOR`) and offers `mdm migrate` when v1 lock files are present.

**`schemas/`** - `mdm-lock.schema.json` and `mdm-state.schema.json`, registered through `contributes.jsonValidation`. `contributes.languages` associates the `mdm.lock` filename with the built-in `json` language. The schemas mirror the Go structs in `internal/lock` of the CLI (`ProjectLockFile`, `GlobalState`, and their entry types); keep them in sync when the lock gains a key.

## Git Conventions

These match [`sethcarney/mdm`](https://github.com/sethcarney/mdm), so the two
repositories read the same way.

### Commit messages

Use semantic (Conventional Commits) format:

```
<type>(<scope>): <short description>

[optional body]
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`

### Branch naming

Use a `<type>/<short-description>` prefix matching the commit type:

```
feat/audit-badges
fix/mdm-v2-harness-commands
chore/bump-types-vscode
docs/readme-v2-requirement
```

This applies to AI agents too, and overrides whatever branch a coding-agent
harness assigns. Claude Code on the web, for example, opens each session on a
generated branch name (`claude/<description>-<id>`, `feature/<generated>`, and
others depending on the surface); move the work to a branch named by the
convention above before pushing, rather than pushing the generated name.

### Commit authorship

Commits are authored by the person running the tool, not by the tool. An agent
that finds a bot identity in `git config user.name` / `user.email` - some
hosted environments preset one - should commit under the repository owner's
identity instead, matching what `git log` already shows:

```
Seth <48496865+sethcarney@users.noreply.github.com>
```

Agent attribution is disabled for this repository: do not add
`Co-Authored-By:` trailers, `Generated with` footers, or session links to
commits or pull requests. `.claude/settings.json` turns off Claude Code's
automatic attribution to match. Authorship carries the accountability, and
the repository owner reviews everything an agent produces before it lands.

## Key constraints

- **`mdm.lock` is the only lock format the extension reads.** The pre-release `mdm-lock.json` is not supported at all. The v1 names (`skills-lock.json`, `knowledge-lock.json`, `plugins-lock.json`) are detected but never parsed for data: their only job is to trigger the `mdm migrate` offer. `mdm migrate` leaves a tombstone at `skills-lock.json` carrying a `_moved` key, so detection checks for that key rather than mere existence.
- Vocabulary follows the CLI: a **harness** is the AI tool (Claude Code, Cursor, …; `mdm harnesses`, `--harness`), an **agent** is an agent definition file (`mdm agents`, `--agent`). Pre-harness v2 builds called harnesses "agents"; do not reintroduce `mdm agents list --json` or `--agent` for a harness.
- `mdm harnesses list --json` prints `[]` when nothing is configured, but older builds exited non-zero on an empty project list; `listHarnesses` still parses `stdout` off the error object and falls back to `[]`.
- The harness's CLI identifier (`name`, e.g. `claude-code`) is preserved in `MdmItem.cliName`. Never re-derive it by slugifying the display name; the JSON already carries the canonical value.
- The install mode is scope-wide and only switchable through commands that install (`mdm skills install --copy|--symlink` here). `_mdm.setInstallMode#sideBar` refuses when the project lock has no skills, because under `-y` the CLI would restore (and re-mode) the global state instead.
- `mdm doctor` exits 1 when it finds an error-level issue; the report is still on `stdout` and is shown when it contains "Doctor complete".
- The `tsconfig.json` explicitly sets `"types": ["node"]`, required because the `lib` array doesn't include DOM, so TypeScript won't auto-include `@types/node`.
- `typescript` is held at `^6.0.3`. TypeScript 7 compiles this project fine, but typescript-eslint's peer range is `>=4.8.4 <6.1.0` and its plugin hard-errors on load under TS 7 ("typescript-eslint does not support TS 7.0"), so `bun run lint` fails. TS 7.0 exposes no stable programmatic API (that arrives in 7.1), so this is upstream's timeline, not ours. `.github/dependabot.yml` ignores `typescript >= 7`; remove that ignore once typescript-eslint ships TS 7 support.
- ESLint enforces the `curly` rule: all `if` bodies need braces. `@typescript-eslint/no-floating-promises` is set to `error`, so all promises must be `await`ed or explicitly discarded with `void`.
- CI runs `bun run format:check`; run `bun run format` locally before pushing if your editor doesn't format on save.
