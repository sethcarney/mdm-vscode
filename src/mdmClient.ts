import { execFile } from 'child_process';
import { promisify } from 'util';
import { access } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export type MdmResourceType = 'skills' | 'agents';
export type MdmScope = 'global' | 'project';

export interface RulesEntry {
  file: string;
  state: 'linked' | 'missing' | 'real' | string;
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

export interface MdmItem {
  name: string;
  description?: string;
  scope: MdmScope;
  /** Absolute path to the file this item represents, if any. */
  filePath?: string;
  /** Human-readable status label, e.g. "✓ installed". */
  status?: string;
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
    return vscode.workspace.getConfiguration('mdm').get<string>('cliPath', 'mdm');
  }

  private get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  clearCache(): void {
    this._installed = undefined;
  }

  async checkInstalled(): Promise<boolean> {
    if (this._installed !== undefined) { return this._installed; }
    try {
      await execFileAsync(this.cliPath, ['--version'], { timeout: 5000, cwd: this.workspaceRoot });
      this._installed = true;
    } catch {
      this._installed = false;
    }
    return this._installed;
  }

  async listItems(resource: MdmResourceType): Promise<MdmItem[]> {
    if (resource === 'skills') { return this.listSkills(); }
    return this.listAgents();
  }

  async removeSkill(name: string, scope: MdmScope): Promise<void> {
    const args = ['skills', 'remove', name, '-y'];
    if (scope === 'global') { args.push('--global'); }
    await execFileAsync(this.cliPath, args, { timeout: 30_000, cwd: this.workspaceRoot });
  }

  async updateSkill(name: string, scope: MdmScope): Promise<void> {
    const args = ['skills', 'update', name, '-y', scope === 'global' ? '-g' : '-p'];
    await execFileAsync(this.cliPath, args, { timeout: 60_000, cwd: this.workspaceRoot });
  }

  async removeAgent(name: string, global: boolean): Promise<void> {
    const args = ['agents', 'remove', name, '-y'];
    if (global) { args.push('--global'); }
    await execFileAsync(this.cliPath, args, { timeout: 10_000, cwd: this.workspaceRoot });
  }

  async addAgent(name: string, global: boolean): Promise<void> {
    const args = ['agents', 'add', name];
    if (global) { args.push('--global'); }
    await execFileAsync(this.cliPath, args, { timeout: 10_000, cwd: this.workspaceRoot });
  }

  async listAvailableAgents(): Promise<KnownAgent[]> {
    const { stdout } = await execFileAsync(
      this.cliPath, ['agents', 'list', '--available', '--json'],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    const text = stdout.trim();
    if (!text) { return []; }
    return JSON.parse(text) as KnownAgent[];
  }

  async addSkill(repo: string, scope: MdmScope, skillName?: string, opts: { allowHiddenChars?: boolean; skipAudit?: boolean } = {}): Promise<void> {
    const args = ['skills', 'add', repo, '-y', '--fail-on-audit'];
    if (skillName) { args.push('-s', skillName); }
    if (scope === 'global') { args.push('-g'); } else { args.push('-p'); }
    if (opts.allowHiddenChars) { args.push('--allow-hidden-chars'); }
    if (opts.skipAudit) { args.push('--skip-audit'); }
    await execFileAsync(this.cliPath, args, { timeout: 120_000, cwd: this.workspaceRoot });
  }

  async preInstallAudit(skillSource: string, skillName?: string): Promise<AuditResult[]> {
    const args = ['skills', 'audit', '--source', skillSource];
    if (skillName) { args.push('--skill', skillName); }
    args.push('--json');
    const parse = (text: string): AuditResult[] => {
      const trimmed = text.trim();
      return trimmed ? (JSON.parse(trimmed) as AuditResult[]) : [];
    };
    try {
      const { stdout } = await execFileAsync(this.cliPath, args, { timeout: 15_000, cwd: this.workspaceRoot });
      return parse(stdout);
    } catch (err) {
      const stdout = (err as Record<string, unknown>)['stdout'];
      if (typeof stdout === 'string' && stdout.trim()) {
        return parse(stdout);
      }
      throw err;
    }
  }

  async findSkills(query: string): Promise<FindSkillResult[]> {
    const { stdout } = await execFileAsync(
      this.cliPath, ['skills', 'find', query, '--json'],
      { timeout: 15_000, cwd: this.workspaceRoot }
    );
    const text = stdout.trim();
    if (!text) { return []; }
    return JSON.parse(text) as FindSkillResult[];
  }

  async auditSkills(scope?: MdmScope): Promise<AuditResult[]> {
    const args = ['skills', 'audit', '--json'];
    if (scope === 'global') { args.push('-g'); }
    if (scope === 'project') { args.push('-p'); }
    const { stdout } = await execFileAsync(this.cliPath, args, { timeout: 30_000, cwd: this.workspaceRoot });
    const text = stdout.trim();
    if (!text) { return []; }
    return JSON.parse(text) as AuditResult[];
  }

  async updateAllSkills(scope?: MdmScope): Promise<void> {
    const args = ['skills', 'update', '-y'];
    if (scope === 'global') { args.push('-g'); }
    if (scope === 'project') { args.push('-p'); }
    await execFileAsync(this.cliPath, args, { timeout: 120_000, cwd: this.workspaceRoot });
  }

  async hasSkillsLockFile(): Promise<boolean> {
    const root = this.workspaceRoot;
    if (!root) { return false; }
    try {
      await access(path.join(root, 'skills-lock.json'));
      return true;
    } catch {
      return false;
    }
  }

  async runDoctor(): Promise<string> {
    const { stdout } = await execFileAsync(
      this.cliPath, ['doctor'],
      { timeout: 30_000, cwd: this.workspaceRoot }
    );
    return stripAnsi(stdout);
  }

  async rulesStatus(): Promise<RulesEntry[]> {
    const { stdout } = await execFileAsync(
      this.cliPath, ['rules', 'status', '--json'],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    const text = stdout.trim();
    if (!text) { return []; }
    return JSON.parse(text) as RulesEntry[];
  }

  async rulesLink(agent: string): Promise<void> {
    await execFileAsync(
      this.cliPath, ['rules', 'link', '--agent', agent, '-y'],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
  }

  async rulesUnlink(agent: string): Promise<void> {
    await execFileAsync(
      this.cliPath, ['rules', 'unlink', '--agent', agent, '-y'],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
  }

  async installSkills(): Promise<void> {
    await execFileAsync(
      this.cliPath, ['skills', 'install', '-y'],
      { timeout: 60_000, cwd: this.workspaceRoot }
    );
  }

  private async listSkills(): Promise<MdmItem[]> {
    const { stdout } = await execFileAsync(
      this.cliPath, ['skills', 'list', '--json'],
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    return parseSkillsJson(stdout);
  }

  private async listAgents(): Promise<MdmItem[]> {
    const opts = { timeout: 10_000, cwd: this.workspaceRoot };
    const globalAgentsFile = path.join(os.homedir(), '.agents', 'AGENTS.md');
    const projectAgentsFile = this.workspaceRoot ? path.join(this.workspaceRoot, 'AGENTS.md') : undefined;

    const fetchScope = async (global: boolean): Promise<AgentJson[]> => {
      const args = ['agents', 'list', '--json'];
      if (global) { args.push('--global'); }
      try {
        const { stdout } = await execFileAsync(this.cliPath, args, opts);
        const text = stdout.trim();
        return text ? (JSON.parse(text) as AgentJson[]) : [];
      } catch (err) {
        const stdout = (err as Record<string, unknown>)['stdout'];
        if (typeof stdout === 'string' && stdout.trim()) {
          return JSON.parse(stdout.trim()) as AgentJson[];
        }
        return [];
      }
    };

    const [globalAgents, projectAgents] = await Promise.all([fetchScope(true), fetchScope(false)]);

    return [...globalAgents, ...projectAgents].map(agent => ({
      name: agent.displayName,
      scope: agent.scope,
      filePath: agent.scope === 'global' ? globalAgentsFile : projectAgentsFile,
    }));
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*m/g, '');
}

function parseSkillsJson(raw: string): MdmItem[] {
  const text = raw.trim();
  if (!text) { return []; }

  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) { return []; }

  return data.map(entry => {
    const obj = entry as Record<string, unknown>;
    const name = String(obj['Name'] ?? obj['name'] ?? 'Unknown');
    const desc = obj['Description'] ?? obj['description'];
    const scopeRaw = String(obj['Scope'] ?? obj['scope'] ?? 'global').toLowerCase();
    const itemPath = String(obj['Path'] ?? obj['path'] ?? '');
    return {
      name,
      description: desc !== undefined && desc !== null ? String(desc) : undefined,
      scope: scopeRaw === 'project' ? 'project' : 'global',
      filePath: itemPath ? path.join(itemPath, 'SKILL.md') : undefined,
    } satisfies MdmItem;
  });
}
