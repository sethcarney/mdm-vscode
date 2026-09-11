import { execFile } from "child_process";
import { promisify } from "util";
import { access, readFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

/** The unified v2 project lock at the project root (JSON content). */
export const PROJECT_LOCK_NAME = "mdm.lock";

/**
 * The name the v2 lock carried before the rename to mdm.lock. The CLI has no
 * compatibility read of it, so the extension only detects it to nudge.
 */
export const PRE_RELEASE_LOCK_NAME = "mdm-lock.json";

/** v1 per-feature lock files that `mdm migrate` folds into mdm.lock. */
export const LEGACY_LOCK_NAMES = [
  "skills-lock.json",
  "knowledge-lock.json",
  "plugins-lock.json"
] as const;

/** Every lock file name whose change on disk should refresh the views. */
export const ALL_LOCK_NAMES = [
  PROJECT_LOCK_NAME,
  PRE_RELEASE_LOCK_NAME,
  ...LEGACY_LOCK_NAMES
] as const;

/**
 * Tree resources: skills, agent definitions (`mdm agents`, single markdown
 * or TOML persona files), and harnesses (`mdm harnesses`, the AI tools
 * themselves).
 */
export type MdmResourceType = "skills" | "agents" | "harnesses";
export type MdmScope = "global" | "project";
export type InstallMode = "symlink" | "copy";

export interface RulesEntry {
  file: string;
  state: "linked" | "missing" | "real" | "broken" | "standalone" | string;
  target?: string;
  /** Harness names (the JSON key is still `agents` for compatibility). */
  agents: string[];
}

export interface KnownHarness {
  name: string;
  displayName: string;
  installed: boolean;
}

export interface FindSkillResult {
  name: string;
  description: string;
  source: string;
  stars?: number;
  owner?: string;
  repo?: string;
}

export interface RemoteSkillEntry {
  name: string;
  description?: string;
}

export interface AuditProvider {
  provider: string;
  slug?: string;
  status: string;
  riskLevel?: string;
  summary?: string;
  auditedAt?: string;
}

export interface AuditResult {
  name: string;
  scope: string;
  sourceType: string;
  source: string;
  updatedAt?: string;
  syncStatus: string;
  audits?: AuditProvider[];
  skillId?: string;
  registryError?: boolean;
}

export interface LockSectionEntry {
  name: string;
  source: string;
  ref?: string;
  installDir?: string;
  specVersion?: string;
  /** Plugin manifest version, when present. */
  version?: string;
  /** Skill names a plugin installs, when present. */
  skills?: string[];
}

export interface ProjectLockSections {
  knowledge: LockSectionEntry[];
  plugins: LockSectionEntry[];
}

export interface ScopeInstallModes {
  project?: InstallMode;
  global?: InstallMode;
}

export interface MdmItem {
  name: string;
  description?: string;
  scope: MdmScope;
  /** Absolute path to the file this item represents, if any. */
  filePath?: string;
  /** Human-readable status label, e.g. "✓ installed". */
  status?: string;
  /** Git ref (tag, branch, or commit hash) for the installed version. */
  ref?: string;
  /** Canonical CLI identifier (e.g. "claude-code"). Falls back to `name`. */
  cliName?: string;
  /** Harnesses a skill is installed to (from `mdm skills list --json`). */
  harnesses?: string[];
  /** Owning plugin, when a skill was installed via `mdm plugins`. */
  plugin?: string;
  /** Source the entry was installed from (agent definitions). */
  source?: string;
  /** Canonical file format for agent definitions: "markdown" or "toml". */
  format?: string;
}

interface HarnessJson {
  name: string;
  displayName: string;
  scope: MdmScope;
  installed: boolean;
}

export class MdmClient {
  private _installed: boolean | undefined;

  private get cliPath(): string {
    return vscode.workspace
      .getConfiguration("mdm")
      .get<string>("cliPath", "mdm");
  }

  private get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  clearCache(): void {
    this._installed = undefined;
  }

  async checkInstalled(): Promise<boolean> {
    if (this._installed !== undefined) {
      return this._installed;
    }
    try {
      await execFileAsync(this.cliPath, ["--version"], {
        timeout: 5000,
        cwd: this.workspaceRoot
      });
      this._installed = true;
    } catch {
      this._installed = false;
    }
    return this._installed;
  }

  async listItems(resource: MdmResourceType): Promise<MdmItem[]> {
    switch (resource) {
      case "skills":
        return this.listSkills();
      case "agents":
        return this.listAgentDefinitions();
      case "harnesses":
        return this.listHarnesses();
    }
  }

  // ---------------------------------------------------------------------
  // Skills
  // ---------------------------------------------------------------------

  async removeSkill(name: string, scope: MdmScope): Promise<void> {
    const args = ["skills", "remove", name, "-y"];
    if (scope === "global") {
      args.push("--global");
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 30_000,
      cwd: this.workspaceRoot
    });
  }

  async updateSkill(name: string, scope: MdmScope): Promise<void> {
    const args = [
      "skills",
      "update",
      name,
      "-y",
      scope === "global" ? "-g" : "-p"
    ];
    await execFileAsync(this.cliPath, args, {
      timeout: 60_000,
      cwd: this.workspaceRoot
    });
  }

  async addSkill(
    repo: string,
    scope: MdmScope,
    skillName?: string,
    opts: { allowHiddenChars?: boolean; skipAudit?: boolean } = {}
  ): Promise<void> {
    const args = ["skills", "add", repo, "-y", "--fail-on-audit"];
    if (skillName) {
      args.push("-s", skillName);
    }
    if (scope === "global") {
      args.push("-g");
    } else {
      args.push("-p");
    }
    if (opts.allowHiddenChars) {
      args.push("--allow-hidden-chars");
    }
    if (opts.skipAudit) {
      args.push("--skip-audit");
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  /**
   * Forks skills from a source into ./skills as the project's own copies
   * (`mdm skills cherry-pick`). Nothing updates a fork afterwards; the
   * provenance and license are recorded inside it. Returns the CLI output.
   */
  async cherryPickSkills(
    source: string,
    skillNames: string[],
    opts: { install?: boolean; force?: boolean } = {}
  ): Promise<string> {
    const args = ["skills", "cherry-pick", source, "-y"];
    for (const name of skillNames) {
      args.push("-s", name);
    }
    if (opts.install) {
      args.push("--install", "-p");
    }
    if (opts.force) {
      args.push("--force");
    }
    const { stdout } = await execFileAsync(this.cliPath, args, {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
    return stripAnsi(stdout);
  }

  async preInstallAudit(
    skillSource: string,
    skillName?: string
  ): Promise<AuditResult[]> {
    const args = ["skills", "audit", "--source", skillSource];
    if (skillName) {
      args.push("--skill", skillName);
    }
    args.push("--json");
    const parse = (text: string): AuditResult[] =>
      assertJsonArray(text, isAuditResult, "skills audit --source");
    try {
      const { stdout } = await execFileAsync(this.cliPath, args, {
        timeout: 15_000,
        cwd: this.workspaceRoot
      });
      return parse(stdout);
    } catch (err) {
      const stdout = (err as Record<string, unknown>)["stdout"];
      if (typeof stdout === "string" && stdout.trim()) {
        return parse(stdout);
      }
      throw err;
    }
  }

  async findSkills(query: string): Promise<FindSkillResult[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["skills", "find", query, "--json"],
      { timeout: 15_000, cwd: this.workspaceRoot }
    );
    return assertJsonArray(stdout, isFindSkillResult, "skills find");
  }

  async listRemoteSkills(source: string): Promise<RemoteSkillEntry[]> {
    const parse = (text: string): RemoteSkillEntry[] =>
      assertJsonArray(text, isRemoteSkillEntry, "skills find --source");
    try {
      const { stdout } = await execFileAsync(
        this.cliPath,
        ["skills", "find", "--source", source, "--json"],
        { timeout: 15_000, cwd: this.workspaceRoot }
      );
      return parse(stdout);
    } catch (err) {
      const stdout = (err as Record<string, unknown>)["stdout"];
      if (typeof stdout === "string" && stdout.trim()) {
        return parse(stdout);
      }
      throw err;
    }
  }

  async auditSkills(scope?: MdmScope): Promise<AuditResult[]> {
    const args = ["skills", "audit", "--json"];
    if (scope === "global") {
      args.push("-g");
    }
    if (scope === "project") {
      args.push("-p");
    }
    const { stdout } = await execFileAsync(this.cliPath, args, {
      timeout: 30_000,
      cwd: this.workspaceRoot
    });
    return assertJsonArray(stdout, isAuditResult, "skills audit");
  }

  async updateAllSkills(scope?: MdmScope): Promise<void> {
    const args = ["skills", "update", "-y"];
    if (scope === "global") {
      args.push("-g");
    }
    if (scope === "project") {
      args.push("-p");
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  /**
   * `mdm skills install` restores every skill, then every agent definition,
   * recorded in the lock. With a mode flag it also switches the scope's
   * install mode, re-materializing existing installs first.
   */
  async installSkills(mode?: InstallMode): Promise<void> {
    const args = ["skills", "install", "-y"];
    if (mode) {
      args.push(`--${mode}`);
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  // ---------------------------------------------------------------------
  // Agent definitions (mdm agents)
  // ---------------------------------------------------------------------

  async addAgentDefinitions(
    source: string,
    scope: MdmScope,
    opts: { harnesses?: string[]; names?: string[] } = {}
  ): Promise<void> {
    const args = ["agents", "add", source, "-y"];
    args.push(scope === "global" ? "-g" : "-p");
    for (const harness of opts.harnesses ?? []) {
      args.push("--harness", harness);
    }
    for (const name of opts.names ?? []) {
      args.push("--agent", name);
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  async updateAgentDefinition(name: string, scope: MdmScope): Promise<void> {
    await execFileAsync(
      this.cliPath,
      ["agents", "update", name, "-y", scope === "global" ? "-g" : "-p"],
      { timeout: 120_000, cwd: this.workspaceRoot }
    );
  }

  async updateAllAgentDefinitions(scope?: MdmScope): Promise<void> {
    const args = ["agents", "update", "-y"];
    if (scope === "global") {
      args.push("-g");
    }
    if (scope === "project") {
      args.push("-p");
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  async removeAgentDefinition(name: string, scope: MdmScope): Promise<void> {
    await execFileAsync(
      this.cliPath,
      ["agents", "remove", name, "-y", scope === "global" ? "-g" : "-p"],
      { timeout: 30_000, cwd: this.workspaceRoot }
    );
  }

  /** Restores every agent definition recorded in the project and global locks. */
  async installAgentDefinitions(): Promise<void> {
    await execFileAsync(this.cliPath, ["agents", "install", "-y"], {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  /**
   * `mdm agents list` has no --json, so agent definitions come straight
   * from the lock files: the `agents` section of mdm.lock (project) and of
   * mdm-state.json (global). The canonical file lives at
   * `.agents/agents/<name>.md` (or `.toml` for a Codex source).
   */
  private async listAgentDefinitions(): Promise<MdmItem[]> {
    const root = this.workspaceRoot;
    const [projectLock, globalState] = await Promise.all([
      root ? readJsonFile(path.join(root, PROJECT_LOCK_NAME)) : undefined,
      readJsonFile(globalStatePath())
    ]);
    const build = async (
      section: unknown,
      scope: MdmScope,
      baseDir: string | undefined
    ): Promise<MdmItem[]> => {
      if (typeof section !== "object" || section === null || !baseDir) {
        return [];
      }
      const items = await Promise.all(
        Object.entries(section as Record<string, unknown>).map(
          async ([name, value]): Promise<MdmItem | undefined> => {
            if (typeof value !== "object" || value === null) {
              return undefined;
            }
            const o = value as Record<string, unknown>;
            const str = (key: string): string | undefined =>
              typeof o[key] === "string" ? (o[key] as string) : undefined;
            const format = str("format") === "toml" ? "toml" : "markdown";
            const filePath = path.join(
              baseDir,
              ".agents",
              "agents",
              `${name}${format === "toml" ? ".toml" : ".md"}`
            );
            const present = await fileExists(filePath);
            return {
              name,
              scope,
              filePath,
              ref: str("ref"),
              source: str("source"),
              format,
              description: str("source"),
              status: present ? undefined : "⚠ file missing"
            };
          }
        )
      );
      return items
        .filter((v): v is MdmItem => v !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));
    };
    const [globalItems, projectItems] = await Promise.all([
      build(globalState?.["agents"], "global", os.homedir()),
      build(projectLock?.["agents"], "project", root)
    ]);
    return [...globalItems, ...projectItems];
  }

  // ---------------------------------------------------------------------
  // Harnesses (mdm harnesses) - the AI tools mdm installs into
  // ---------------------------------------------------------------------

  async removeHarness(name: string, scope: MdmScope): Promise<void> {
    const args = ["harnesses", "remove", name, "-y"];
    if (scope === "global") {
      args.push("--global");
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 10_000,
      cwd: this.workspaceRoot
    });
  }

  async addHarness(name: string, scope: MdmScope): Promise<void> {
    const args = ["harnesses", "add", name];
    if (scope === "global") {
      args.push("--global");
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 10_000,
      cwd: this.workspaceRoot
    });
  }

  async listAvailableHarnesses(): Promise<KnownHarness[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["harnesses", "list", "--available", "--json"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    return assertJsonArray(
      stdout,
      isKnownHarness,
      "harnesses list --available"
    );
  }

  private async listHarnesses(): Promise<MdmItem[]> {
    const opts = { timeout: 10_000, cwd: this.workspaceRoot };
    const globalStateFile = await firstExisting(
      globalStatePath(),
      path.join(os.homedir(), ".agents", "skills-lock.json")
    );
    const projectLockFile = this.workspaceRoot
      ? await firstExisting(
          path.join(this.workspaceRoot, PROJECT_LOCK_NAME),
          path.join(this.workspaceRoot, "skills-lock.json")
        )
      : undefined;

    const fetchScope = async (global: boolean): Promise<HarnessJson[]> => {
      const args = ["harnesses", "list", "--json"];
      if (global) {
        args.push("--global");
      }
      try {
        const { stdout } = await execFileAsync(this.cliPath, args, opts);
        return assertJsonArray(stdout, isHarnessJson, "harnesses list");
      } catch (err) {
        // Older builds exit non-zero on an empty project list; the JSON
        // is still on stdout.
        const stdout = (err as Record<string, unknown>)["stdout"];
        if (typeof stdout === "string" && stdout.trim()) {
          return assertJsonArray(stdout, isHarnessJson, "harnesses list");
        }
        return [];
      }
    };

    const [globalHarnesses, projectHarnesses, rulesEntries] = await Promise.all(
      [
        fetchScope(true),
        fetchScope(false),
        this.rulesStatus().catch((): RulesEntry[] => [])
      ]
    );

    const unlinkedRules = new Set(
      rulesEntries
        .filter(
          (e) =>
            e.state === "missing" ||
            e.state === "broken" ||
            e.state === "standalone"
        )
        .flatMap((e) => e.agents)
    );

    return [...globalHarnesses, ...projectHarnesses].map((harness) => ({
      name: harness.displayName,
      cliName: harness.name,
      scope: harness.scope,
      filePath: harness.scope === "global" ? globalStateFile : projectLockFile,
      status: harness.installed ? "✓ installed" : undefined,
      description: unlinkedRules.has(harness.name)
        ? "rules not linked to AGENTS.md"
        : undefined
    }));
  }

  // ---------------------------------------------------------------------
  // Lock files
  // ---------------------------------------------------------------------

  async hasProjectLockFile(): Promise<boolean> {
    return (await this.projectLockPath()) !== undefined;
  }

  /** The project lock file on disk, preferring mdm.lock over the v1 name. */
  async projectLockPath(): Promise<string | undefined> {
    const root = this.workspaceRoot;
    if (!root) {
      return undefined;
    }
    for (const name of [PROJECT_LOCK_NAME, "skills-lock.json"]) {
      const candidate = path.join(root, name);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * True when the project still carries the pre-release v2 lock name
   * (mdm-lock.json) and no mdm.lock. The released CLI does not read the
   * old name, so the file is invisible until renamed.
   */
  async hasPreReleaseLockFile(): Promise<boolean> {
    const root = this.workspaceRoot;
    if (!root) {
      return false;
    }
    const [stale, current] = await Promise.all([
      fileExists(path.join(root, PRE_RELEASE_LOCK_NAME)),
      fileExists(path.join(root, PROJECT_LOCK_NAME))
    ]);
    return stale && !current;
  }

  /**
   * v1 lock files still present in the project. mdm v2 reads them
   * transparently but only ever writes mdm.lock, so their presence means
   * `mdm migrate` has not been run yet. The skills-lock.json tombstone
   * that migration leaves behind (marked with "_moved") does not count.
   */
  async detectLegacyLockFiles(): Promise<string[]> {
    const root = this.workspaceRoot;
    if (!root) {
      return [];
    }
    const found: string[] = [];
    for (const name of LEGACY_LOCK_NAMES) {
      const data = await readJsonFile(path.join(root, name));
      if (data && typeof data["_moved"] !== "string") {
        found.push(name);
      }
    }
    return found;
  }

  /**
   * The install mode each scope records: `installMode` in mdm.lock and in
   * mdm-state.json. An absent value means symlink, the default.
   */
  async readInstallModes(): Promise<ScopeInstallModes> {
    const root = this.workspaceRoot;
    const [projectLock, globalState] = await Promise.all([
      root ? readJsonFile(path.join(root, PROJECT_LOCK_NAME)) : undefined,
      readJsonFile(globalStatePath())
    ]);
    return {
      project: parseInstallMode(projectLock?.["installMode"]),
      global: parseInstallMode(globalState?.["installMode"])
    };
  }

  /** Number of skills the project lock records, for the mode-switch guard. */
  async projectLockSkillCount(): Promise<number> {
    const root = this.workspaceRoot;
    if (!root) {
      return 0;
    }
    const lock = await readJsonFile(path.join(root, PROJECT_LOCK_NAME));
    const skills = lock?.["skills"];
    return typeof skills === "object" && skills !== null
      ? Object.keys(skills as object).length
      : 0;
  }

  /**
   * Knowledge and plugin entries come straight from the project lock -
   * mdm.lock is the source of truth, with the v1 per-feature files as a
   * pre-migration fallback. No CLI round trip needed for listing.
   */
  async readProjectLockSections(): Promise<ProjectLockSections> {
    const root = this.workspaceRoot;
    const empty: ProjectLockSections = { knowledge: [], plugins: [] };
    if (!root) {
      return empty;
    }
    const unified = await readJsonFile(path.join(root, PROJECT_LOCK_NAME));
    if (unified) {
      return {
        knowledge: parseLockSection(unified["knowledge"]),
        plugins: parseLockSection(unified["plugins"])
      };
    }
    const [legacyKnowledge, legacyPlugins] = await Promise.all([
      readJsonFile(path.join(root, "knowledge-lock.json")),
      readJsonFile(path.join(root, "plugins-lock.json"))
    ]);
    return {
      knowledge: parseLockSection(legacyKnowledge?.["bundles"]),
      plugins: parseLockSection(legacyPlugins?.["plugins"])
    };
  }

  // ---------------------------------------------------------------------
  // Version / migration / diagnostics
  // ---------------------------------------------------------------------

  /** Reported CLI semver major, or undefined for dev builds. */
  async cliMajorVersion(): Promise<number | undefined> {
    try {
      const { stdout } = await execFileAsync(this.cliPath, ["--version"], {
        timeout: 5000,
        cwd: this.workspaceRoot
      });
      const match = /(\d+)\.\d+\.\d+/.exec(stripAnsi(stdout));
      return match ? Number(match[1]) : undefined;
    } catch {
      return undefined;
    }
  }

  async migrateDryRun(): Promise<string> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["migrate", "--dry-run"],
      { timeout: 30_000, cwd: this.workspaceRoot }
    );
    return stripAnsi(stdout);
  }

  async migrate(
    opts: { deleteOldFiles?: boolean; force?: boolean } = {}
  ): Promise<string> {
    const args = ["migrate", "-y"];
    if (opts.deleteOldFiles) {
      args.push("--no-tombstone");
    }
    if (opts.force) {
      args.push("--force");
    }
    const { stdout } = await execFileAsync(this.cliPath, args, {
      timeout: 60_000,
      cwd: this.workspaceRoot
    });
    return stripAnsi(stdout);
  }

  async runDoctor(): Promise<string> {
    const { stdout } = await execFileAsync(this.cliPath, ["doctor"], {
      timeout: 30_000,
      cwd: this.workspaceRoot
    });
    return stripAnsi(stdout);
  }

  /**
   * `mdm bug --print` builds a prefilled GitHub issue-form URL from the
   * local environment (version, OS, shell, detected harnesses) without
   * opening a browser or sending anything. The URL is the last line.
   */
  async bugReportUrl(): Promise<string> {
    const { stdout } = await execFileAsync(this.cliPath, ["bug", "--print"], {
      timeout: 10_000,
      cwd: this.workspaceRoot
    });
    const lines = stripAnsi(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const url = [...lines].reverse().find((l) => /^https?:\/\//.test(l));
    if (!url) {
      throw new Error("mdm bug did not print an issue URL");
    }
    return url;
  }

  // ---------------------------------------------------------------------
  // Knowledge / plugins
  // ---------------------------------------------------------------------

  async removeKnowledge(name: string): Promise<void> {
    await execFileAsync(this.cliPath, ["knowledge", "remove", name, "-y"], {
      timeout: 30_000,
      cwd: this.workspaceRoot
    });
  }

  async updateKnowledge(name: string): Promise<void> {
    await execFileAsync(this.cliPath, ["knowledge", "update", name], {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  async removePlugin(name: string, purgeData: boolean): Promise<void> {
    const args = ["plugins", "remove", name, "-y"];
    if (purgeData) {
      args.push("--purge-data");
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 30_000,
      cwd: this.workspaceRoot
    });
  }

  async updatePlugin(name: string): Promise<void> {
    await execFileAsync(this.cliPath, ["plugins", "update", name], {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  async addKnowledge(source: string): Promise<void> {
    await execFileAsync(this.cliPath, ["knowledge", "add", source, "-y"], {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  async addPlugin(source: string, harnesses: string[]): Promise<void> {
    const args = ["plugins", "add", source, "-y"];
    for (const harness of harnesses) {
      args.push("--harness", harness);
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  async installKnowledge(): Promise<void> {
    await execFileAsync(this.cliPath, ["knowledge", "install"], {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  async installPlugins(): Promise<void> {
    await execFileAsync(this.cliPath, ["plugins", "install"], {
      timeout: 120_000,
      cwd: this.workspaceRoot
    });
  }

  // ---------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------

  async rulesStatus(): Promise<RulesEntry[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["rules", "status", "--json"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    return assertJsonArray(stdout, isRulesEntry, "rules status");
  }

  async rulesLink(harness: string): Promise<void> {
    await execFileAsync(
      this.cliPath,
      ["rules", "link", "--harness", harness, "-y"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
  }

  async rulesUnlink(harness: string): Promise<void> {
    await execFileAsync(
      this.cliPath,
      ["rules", "unlink", "--harness", harness, "-y"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
  }

  private async listSkills(): Promise<MdmItem[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["skills", "list", "--json"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    return parseSkillsJson(stdout);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The per-user state file (`mdm-state.json`), honoring the same
 * XDG_STATE_HOME override the CLI uses.
 */
export function globalStatePath(): string {
  const xdgState = process.env["XDG_STATE_HOME"];
  if (xdgState) {
    return path.join(xdgState, "mdm", "state.json");
  }
  return path.join(os.homedir(), ".agents", "mdm-state.json");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(
  ...candidates: string[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

async function readJsonFile(
  filePath: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    // absent or unreadable - callers treat this as an empty section
  }
  return undefined;
}

function parseInstallMode(value: unknown): InstallMode | undefined {
  return value === "copy"
    ? "copy"
    : value === "symlink"
      ? "symlink"
      : undefined;
}

function parseLockSection(section: unknown): LockSectionEntry[] {
  if (typeof section !== "object" || section === null) {
    return [];
  }
  return Object.entries(section as Record<string, unknown>)
    .map(([name, value]): LockSectionEntry | undefined => {
      if (typeof value !== "object" || value === null) {
        return undefined;
      }
      const o = value as Record<string, unknown>;
      const str = (key: string): string | undefined =>
        typeof o[key] === "string" ? (o[key] as string) : undefined;
      return {
        name,
        source: str("source") ?? "",
        ref: str("ref"),
        installDir: str("installDir"),
        specVersion: str("specVersion"),
        version: str("version"),
        skills: Array.isArray(o["skills"])
          ? (o["skills"] as unknown[]).filter(
              (v): v is string => typeof v === "string"
            )
          : undefined
      };
    })
    .filter((v): v is LockSectionEntry => v !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*m/g, "");
}

function assertJsonArray<T>(
  text: string,
  guard: (v: unknown) => v is T,
  context: string
): T[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const data: unknown = JSON.parse(trimmed);
  if (!Array.isArray(data)) {
    throw new Error(`${context}: expected JSON array from CLI`);
  }
  for (let i = 0; i < data.length; i++) {
    if (!guard(data[i])) {
      throw new Error(`${context}: unexpected shape at index ${i}`);
    }
  }
  return data as T[];
}

function isKnownHarness(v: unknown): v is KnownHarness {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return typeof o["name"] === "string" && typeof o["displayName"] === "string";
}

function isRemoteSkillEntry(v: unknown): v is RemoteSkillEntry {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  return typeof (v as Record<string, unknown>)["name"] === "string";
}

function isFindSkillResult(v: unknown): v is FindSkillResult {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return typeof o["name"] === "string" && typeof o["source"] === "string";
}

function isAuditResult(v: unknown): v is AuditResult {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return typeof o["name"] === "string" && typeof o["scope"] === "string";
}

function isRulesEntry(v: unknown): v is RulesEntry {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return typeof o["file"] === "string" && Array.isArray(o["agents"]);
}

function isHarnessJson(v: unknown): v is HarnessJson {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return typeof o["name"] === "string" && typeof o["displayName"] === "string";
}

function parseSkillsJson(raw: string): MdmItem[] {
  const text = raw.trim();
  if (!text) {
    return [];
  }

  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((entry) => {
    const obj = entry as Record<string, unknown>;
    const name = String(obj["Name"] ?? obj["name"] ?? "Unknown");
    const desc = obj["Description"] ?? obj["description"];
    const scopeRaw = String(
      obj["Scope"] ?? obj["scope"] ?? "global"
    ).toLowerCase();
    const itemPath = String(obj["Path"] ?? obj["path"] ?? "");
    const refRaw = obj["Ref"] ?? obj["ref"];
    const pluginRaw = obj["Plugin"] ?? obj["plugin"];
    // The JSON key for a skill's harnesses is still "Agents": the CLI keeps
    // it as a stable external contract across the harness rename.
    const harnessesRaw = obj["Agents"] ?? obj["agents"] ?? obj["harnesses"];
    return {
      name,
      description:
        desc !== undefined && desc !== null ? String(desc) : undefined,
      scope: scopeRaw === "project" ? "project" : "global",
      filePath: itemPath ? path.join(itemPath, "SKILL.md") : undefined,
      ref: refRaw !== undefined && refRaw !== null ? String(refRaw) : undefined,
      plugin:
        typeof pluginRaw === "string" && pluginRaw ? pluginRaw : undefined,
      harnesses: Array.isArray(harnessesRaw)
        ? (harnessesRaw as unknown[]).filter(
            (v): v is string => typeof v === "string"
          )
        : undefined
    } satisfies MdmItem;
  });
}
