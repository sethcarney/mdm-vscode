import { exec } from 'child_process';
import { promisify } from 'util';
import { access } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

export type MdmResourceType = 'skills' | 'agents';
export type MdmScope = 'global' | 'project';

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
    if (this._installed !== undefined) return this._installed;
    try {
      await execAsync(`"${this.cliPath}" --version`, { timeout: 5000, cwd: this.workspaceRoot });
      this._installed = true;
    } catch {
      this._installed = false;
    }
    return this._installed;
  }

  async listItems(resource: MdmResourceType): Promise<MdmItem[]> {
    if (resource === 'skills') return this.listSkills();
    return this.listAgents();
  }

  async removeSkill(name: string, scope: MdmScope): Promise<void> {
    const scopeFlag = scope === 'global' ? '--global' : '';
    await execAsync(
      `"${this.cliPath}" skills remove ${name} -y ${scopeFlag}`.trimEnd(),
      { timeout: 30_000, cwd: this.workspaceRoot }
    );
  }

  async updateSkill(name: string, scope: MdmScope): Promise<void> {
    const scopeFlag = scope === 'global' ? '-g' : '-p';
    await execAsync(
      `"${this.cliPath}" skills update ${name} -y ${scopeFlag}`,
      { timeout: 60_000, cwd: this.workspaceRoot }
    );
  }

  async removeAgent(name: string, global: boolean): Promise<void> {
    const args = ['agents', 'remove', name, '-y'];
    if (global) { args.push('--global'); }
    await execAsync(
      `"${this.cliPath}" ${args.join(' ')}`,
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
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
    const { stdout } = await execAsync(
      `"${this.cliPath}" doctor`,
      { timeout: 30_000, cwd: this.workspaceRoot }
    );
    return stripAnsi(stdout);
  }

  async installSkills(): Promise<void> {
    await execAsync(
      `"${this.cliPath}" skills install -y`,
      { timeout: 60_000, cwd: this.workspaceRoot }
    );
  }

  private async listSkills(): Promise<MdmItem[]> {
    const { stdout } = await execAsync(
      `"${this.cliPath}" skills list --json`,
      { timeout: 10_000, cwd: this.workspaceRoot }
    );
    return parseSkillsJson(stdout);
  }

  private async listAgents(): Promise<MdmItem[]> {
    const opts = { timeout: 10_000, cwd: this.workspaceRoot };
    const globalAgentsFile = path.join(os.homedir(), '.agents', 'AGENTS.md');
    const projectAgentsFile = this.workspaceRoot ? path.join(this.workspaceRoot, 'AGENTS.md') : undefined;

    const fetchScope = async (global: boolean): Promise<AgentJson[]> => {
      const cmd = `"${this.cliPath}" agents list --json${global ? ' --global' : ''}`;
      try {
        const { stdout } = await execAsync(cmd, opts);
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
  if (!text) return [];

  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) return [];

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

