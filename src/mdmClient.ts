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
 * v1 per-feature lock files. The extension never reads data out of these:
 * mdm.lock is the only format it understands. They are detected solely so
 * the UI can offer `mdm migrate`, which is what turns them into mdm.lock.
 */
export const LEGACY_LOCK_NAMES = [
  "skills-lock.json",
  "knowledge-lock.json",
  "plugins-lock.json"
] as const;

/** Every lock file name whose change on disk should refresh the views. */
export const ALL_LOCK_NAMES = [
  PROJECT_LOCK_NAME,
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

/**
 * A plugin or knowledge bundle as `mdm {plugins,knowledge} list --json`
 * reports it. The health fields (`valid`, `present`, `documents`,
 * `mcpServers`) are disk checks only the CLI can do, which is why these come
 * from the CLI rather than from mdm.lock.
 */
export interface SectionEntry {
  name: string;
  source: string;
  ref?: string;
  installDir: string;
  specVersion: string;
  /** Plugin manifest version. */
  version?: string;
  /** Skill names a plugin installs. */
  skills?: string[];
  /** Harnesses a plugin's skills are installed to. */
  harnesses?: string[];
  /** Wired MCP servers a plugin contributes. */
  mcpServers?: number;
  /** False when a plugin's manifest is missing or invalid on disk. */
  valid?: boolean;
  /** Documents a knowledge bundle holds. */
  documents?: number;
  /** False when a knowledge bundle is missing on disk. */
  present?: boolean;
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
  /** SPDX license of the source repository, when it declares one. */
  license?: string;
  /** Declared harness compatibility, when the skill states it. */
  compatibility?: string;
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
   * `mdm agents list --json`. One call covers both scopes: the CLI flattens
   * them into a single array with `scope` on each entry, the same shape
   * `skills list --json` uses.
   *
   * The JSON carries no file path, so the canonical file is derived from the
   * name and probed for both extensions (`.md`, or `.toml` for a Codex
   * source). `canonicalMissing` is authoritative for whether it exists; the
   * probe only decides which extension to open.
   */
  private async listAgentDefinitions(): Promise<MdmItem[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["agents", "list", "--json"],
      { timeout: 15_000, cwd: this.workspaceRoot }
    );
    const entries = assertJsonArray(stdout, isAgentDefJson, "agents list");
    const root = this.workspaceRoot;
    const items = await Promise.all(
      entries.map(async (entry): Promise<MdmItem> => {
        const scope: MdmScope = entry.scope === "global" ? "global" : "project";
        const baseDir = scope === "global" ? os.homedir() : root;
        const filePath = baseDir
          ? await agentDefinitionPath(baseDir, entry.name)
          : undefined;
        return {
          name: entry.name,
          scope,
          filePath,
          ref: entry.ref,
          source: entry.source,
          description: entry.source,
          status: agentDefinitionStatus(entry)
        };
      })
    );
    return items.sort(
      (a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name)
    );
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
    const globalStateFile = globalStatePath();
    const projectLockFile = this.workspaceRoot
      ? path.join(this.workspaceRoot, PROJECT_LOCK_NAME)
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

  /** The project lock file on disk. mdm.lock is the only format read. */
  async projectLockPath(): Promise<string | undefined> {
    const root = this.workspaceRoot;
    if (!root) {
      return undefined;
    }
    const candidate = path.join(root, PROJECT_LOCK_NAME);
    return (await fileExists(candidate)) ? candidate : undefined;
  }

  /**
   * v1 lock files still present in the project. The extension reads no data
   * from them; their presence just means `mdm migrate` has not been run yet,
   * so the UI can offer it. The skills-lock.json tombstone that migration
   * leaves behind (marked with "_moved") does not count.
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
   * Knowledge and plugin entries come from the CLI rather than from
   * mdm.lock. The lock records what is declared; only the CLI reports
   * whether the bundle or manifest actually loads from disk.
   */
  /** `mdm plugins list --json`. */
  async listPlugins(): Promise<SectionEntry[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["plugins", "list", "--json"],
      { timeout: 15_000, cwd: this.workspaceRoot }
    );
    return assertJsonArray(stdout, isSectionEntry, "plugins list");
  }

  /** `mdm knowledge list --json`. */
  async listKnowledge(): Promise<SectionEntry[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["knowledge", "list", "--json"],
      { timeout: 15_000, cwd: this.workspaceRoot }
    );
    return assertJsonArray(stdout, isSectionEntry, "knowledge list");
  }

  /** Whichever of the two the caller needs. */
  async listSection(section: "knowledge" | "plugins"): Promise<SectionEntry[]> {
    return section === "plugins" ? this.listPlugins() : this.listKnowledge();
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

interface AgentDefJson {
  name: string;
  scope: string;
  source: string;
  ref?: string;
  canonicalMissing: boolean;
  installedIn: string[];
  missingFrom: string[];
}

function isAgentDefJson(v: unknown): v is AgentDefJson {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o["name"] === "string" &&
    typeof o["scope"] === "string" &&
    typeof o["source"] === "string"
  );
}

function isSectionEntry(v: unknown): v is SectionEntry {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return typeof o["name"] === "string" && typeof o["source"] === "string";
}

/**
 * The status line for an agent definition. A missing canonical file is the
 * loudest problem; otherwise a definition the lock says should be in a
 * harness but is not gets named, because that is what the panel exists to
 * surface.
 */
function agentDefinitionStatus(entry: AgentDefJson): string | undefined {
  if (entry.canonicalMissing) {
    return "⚠ file missing";
  }
  if (entry.installedIn.length === 0) {
    return "⚠ not installed in any harness";
  }
  if (entry.missingFrom.length > 0) {
    return `⚠ missing from ${entry.missingFrom.join(", ")}`;
  }
  return undefined;
}

/**
 * Canonical file for an agent definition. Codex sources are TOML, everything
 * else markdown, and the JSON does not say which, so both are probed. The
 * markdown name is the fallback so a missing file still opens somewhere
 * sensible.
 */
async function agentDefinitionPath(
  baseDir: string,
  name: string
): Promise<string> {
  const dir = path.join(baseDir, ".agents", "agents");
  const markdown = path.join(dir, `${name}.md`);
  const toml = path.join(dir, `${name}.toml`);
  if (await fileExists(markdown)) {
    return markdown;
  }
  return (await fileExists(toml)) ? toml : markdown;
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
    const licenseRaw = obj["License"] ?? obj["license"];
    const compatRaw = obj["Compatibility"] ?? obj["compatibility"];
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
      license:
        typeof licenseRaw === "string" && licenseRaw ? licenseRaw : undefined,
      compatibility:
        typeof compatRaw === "string" && compatRaw ? compatRaw : undefined,
      harnesses: Array.isArray(harnessesRaw)
        ? (harnessesRaw as unknown[]).filter(
            (v): v is string => typeof v === "string"
          )
        : undefined
    } satisfies MdmItem;
  });
}
