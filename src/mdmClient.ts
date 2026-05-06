import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

export type MdmResourceType = 'skills' | 'agents' | 'rules';

export interface MdmItem {
  name: string;
  description?: string;
}

export class MdmClient {
  // Cache the installed check so we don't shell out on every tree refresh.
  private _installed: boolean | undefined;

  private get cliPath(): string {
    return vscode.workspace.getConfiguration('mdm').get<string>('cliPath', 'mdm');
  }

  /** Call when the user changes mdm.cliPath so we re-probe on the next check. */
  clearCache(): void {
    this._installed = undefined;
  }

  async checkInstalled(): Promise<boolean> {
    if (this._installed !== undefined) {
      return this._installed;
    }
    try {
      await execAsync(`"${this.cliPath}" --version`, { timeout: 5000 });
      this._installed = true;
    } catch {
      this._installed = false;
    }
    return this._installed;
  }

  /**
   * Fetch items for a resource.  Tries progressively simpler command forms:
   *   mdm <resource> list --json  →  mdm <resource> list  →  mdm <resource>
   * JSON and plain-text outputs are both handled.
   */
  async listItems(resource: MdmResourceType): Promise<MdmItem[]> {
    const cli = `"${this.cliPath}"`;
    const attempts = [
      `${cli} ${resource} list --json`,
      `${cli} ${resource} list`,
      `${cli} ${resource}`,
    ];

    let lastError: unknown;
    for (const cmd of attempts) {
      try {
        const { stdout } = await execAsync(cmd, { timeout: 10_000 });
        return parseOutput(stdout);
      } catch (err) {
        lastError = err;
      }
    }

    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Failed to list ${resource}: ${msg}`);
  }
}

function parseOutput(raw: string): MdmItem[] {
  const text = raw.trim();
  if (!text) {
    return [];
  }

  // Attempt JSON decode first.
  try {
    const data: unknown = JSON.parse(text);
    if (Array.isArray(data)) {
      return data.map(normalizeItem);
    }
    if (typeof data === 'object' && data !== null) {
      // Handle { skills: [...] } or { data: [...] } wrapper objects.
      for (const val of Object.values(data as Record<string, unknown>)) {
        if (Array.isArray(val)) {
          return val.map(normalizeItem);
        }
      }
    }
  } catch {
    // Fall through to plain-text parsing.
  }

  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(line => {
      // Support "name: description" or "name - description" formats.
      const match = /^([^:-]{1,40})[:-]\s+(.+)$/.exec(line);
      if (match) {
        return { name: match[1].trim(), description: match[2].trim() };
      }
      return { name: line };
    });
}

function normalizeItem(item: unknown): MdmItem {
  if (typeof item === 'string') {
    return { name: item };
  }
  if (typeof item === 'object' && item !== null) {
    const obj = item as Record<string, unknown>;
    const name = String(
      obj['name'] ?? obj['id'] ?? obj['title'] ?? obj['slug'] ?? Object.values(obj)[0] ?? 'Unknown'
    );
    const description = obj['description'] != null ? String(obj['description']) : undefined;
    return { name, description };
  }
  return { name: String(item) };
}
