import { execFile } from "child_process";
import { promisify } from "util";
import { access, readFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export type MdmResourceType = "skills" | "agents";
export type MdmScope = "global" | "project";

export interface RulesEntry {
  file: string;
  state: "linked" | "missing" | "real" | string;
  target?: string;
  agents: string[];
}

export interface KnownAgent {
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
}

interface AgentJson {
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
    if (resource === "skills") {
      return this.listSkills();
    }
    return this.listAgents();
  }

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

  async removeAgent(name: string, scope: MdmScope): Promise<void> {
    const args = ["agents", "remove", name, "-y"];
    if (scope === "global") {
      args.push("--global");
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 10_000,
      cwd: this.workspaceRoot
    });
  }

  async addAgent(name: string, scope: MdmScope): Promise<void> {
    const args = ["agents", "add", name];
    if (scope === "global") {
      args.push("--global");
    }
    await execFileAsync(this.cliPath, args, {
      timeout: 10_000,
      cwd: this.workspaceRoot
    });
  }

  async listAvailableAgents(): Promise<KnownAgent[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["agents", "list", "--available", "--json"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    return assertJsonArray(stdout, isKnownAgent, "agents list --available");
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

  async hasProjectLockFile(): Promise<boolean> {
    const root = this.workspaceRoot;
    if (!root) {
      return false;
    }
    for (const name of ["mdm-lock.json", "skills-lock.json"]) {
      try {
        await access(path.join(root, name));
        return true;
      } catch {
        // keep looking
      }
    }
    return false;
  }

  /**
   * v1 lock files still present in the project. mdm v2 reads them
   * transparently but only ever writes mdm-lock.json, so their presence
   * means `mdm migrate` has not been run yet. The skills-lock.json
   * tombstone that migration leaves behind (marked with "_moved") does
   * not count.
   */
  async detectLegacyLockFiles(): Promise<string[]> {
    const root = this.workspaceRoot;
    if (!root) {
      return [];
    }
    const found: string[] = [];
    for (const name of [
      "skills-lock.json",
      "knowledge-lock.json",
      "plugins-lock.json"
    ]) {
      try {
        const raw = await readFile(path.join(root, name), "utf8");
        const data: unknown = JSON.parse(raw);
        const moved =
          typeof data === "object" && data !== null
            ? (data as Record<string, unknown>)["_moved"]
            : undefined;
        if (typeof moved !== "string") {
          found.push(name);
        }
      } catch {
        // absent or unreadable — migration itself will surface parse errors
      }
    }
    return found;
  }

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

  async migrate(deleteOldFiles: boolean): Promise<string> {
    const args = ["migrate", "-y"];
    if (deleteOldFiles) {
      args.push("--no-tombstone");
    }
    const { stdout } = await execFileAsync(this.cliPath, args, {
      timeout: 60_000,
      cwd: this.workspaceRoot
    });
    return stripAnsi(stdout);
  }

  /**
   * Knowledge and plugin entries come straight from the project lock —
   * mdm-lock.json is the source of truth, with the v1 per-feature files
   * as a pre-migration fallback. No CLI round trip needed for listing.
   */
  async readProjectLockSections(): Promise<ProjectLockSections> {
    const root = this.workspaceRoot;
    const empty: ProjectLockSections = { knowledge: [], plugins: [] };
    if (!root) {
      return empty;
    }
    const unified = await readJsonFile(path.join(root, "mdm-lock.json"));
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

  async runDoctor(): Promise<string> {
    const { stdout } = await execFileAsync(this.cliPath, ["doctor"], {
      timeout: 30_000,
      cwd: this.workspaceRoot
    });
    return stripAnsi(stdout);
  }

  async rulesStatus(): Promise<RulesEntry[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["rules", "status", "--json"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    return assertJsonArray(stdout, isRulesEntry, "rules status");
  }

  async rulesLink(agent: string): Promise<void> {
    await execFileAsync(
      this.cliPath,
      ["rules", "link", "--agent", agent, "-y"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
  }

  async rulesUnlink(agent: string): Promise<void> {
    await execFileAsync(
      this.cliPath,
      ["rules", "unlink", "--agent", agent, "-y"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
  }

  async installSkills(): Promise<void> {
    await execFileAsync(this.cliPath, ["skills", "install", "-y"], {
      timeout: 60_000,
      cwd: this.workspaceRoot
    });
  }

  private async listSkills(): Promise<MdmItem[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      ["skills", "list", "--json"],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    return parseSkillsJson(stdout);
  }

  private async listAgents(): Promise<MdmItem[]> {
    const opts = { timeout: 10_000, cwd: this.workspaceRoot };
    const globalStateFile = await firstExisting(
      path.join(os.homedir(), ".agents", "mdm-state.json"),
      path.join(os.homedir(), ".agents", "skills-lock.json")
    );
    const projectLockFile = this.workspaceRoot
      ? await firstExisting(
          path.join(this.workspaceRoot, "mdm-lock.json"),
          path.join(this.workspaceRoot, "skills-lock.json")
        )
      : undefined;

    const fetchScope = async (global: boolean): Promise<AgentJson[]> => {
      const args = ["agents", "list", "--json"];
      if (global) {
        args.push("--global");
      }
      try {
        const { stdout } = await execFileAsync(this.cliPath, args, opts);
        return assertJsonArray(stdout, isAgentJson, "agents list");
      } catch (err) {
        const stdout = (err as Record<string, unknown>)["stdout"];
        if (typeof stdout === "string" && stdout.trim()) {
          return assertJsonArray(stdout, isAgentJson, "agents list");
        }
        return [];
      }
    };

    const [globalAgents, projectAgents, rulesEntries] = await Promise.all([
      fetchScope(true),
      fetchScope(false),
      this.rulesStatus().catch((): RulesEntry[] => [])
    ]);

    const missingRules = new Set(
      rulesEntries.filter((e) => e.state === "missing").flatMap((e) => e.agents)
    );

    return [...globalAgents, ...projectAgents].map((agent) => ({
      name: agent.displayName,
      cliName: agent.name,
      scope: agent.scope,
      filePath: agent.scope === "global" ? globalStateFile : projectLockFile,
      status: missingRules.has(agent.name) ? "⚠ rules not linked" : undefined
    }));
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

async function firstExisting(
  ...candidates: string[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return candidates[0];
}

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
    // absent or unreadable — callers treat this as an empty section
  }
  return undefined;
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

function isKnownAgent(v: unknown): v is KnownAgent {
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

function isAgentJson(v: unknown): v is AgentJson {
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
    return {
      name,
      description:
        desc !== undefined && desc !== null ? String(desc) : undefined,
      scope: scopeRaw === "project" ? "project" : "global",
      filePath: itemPath ? path.join(itemPath, "SKILL.md") : undefined,
      ref: refRaw !== undefined && refRaw !== null ? String(refRaw) : undefined
    } satisfies MdmItem;
  });
}
