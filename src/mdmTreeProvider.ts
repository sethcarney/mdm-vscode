import * as path from "path";
import * as vscode from "vscode";
import {
  MdmClient,
  MdmItem,
  MdmResourceType,
  MdmScope,
  RulesEntry
} from "./mdmClient";

type TreeItemKind = "scope-header" | "resource-item" | "message" | "action";

export class MdmTreeItem extends vscode.TreeItem {
  readonly kind: TreeItemKind;
  readonly itemScope?: MdmScope;
  readonly mdmItem?: MdmItem;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options: {
      kind: TreeItemKind;
      scope?: MdmScope;
      item?: MdmItem;
      resource?: MdmResourceType;
      isError?: boolean;
      command?: vscode.Command;
    }
  ) {
    super(label, collapsibleState);
    this.kind = options.kind;
    this.itemScope = options.scope;
    this.mdmItem = options.item;

    const { item, isError = false, resource } = options;

    if (isError) {
      this.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("problemsWarningIcon.foreground")
      );
      this.contextValue = "mdm-error";
      return;
    }

    if (options.kind === "scope-header") {
      this.iconPath = new vscode.ThemeIcon(
        options.scope === "global" ? "globe" : "folder"
      );
      if (resource === "agents" || resource === "skills") {
        this.contextValue = `mdm-${resource}-scope-${options.scope ?? "project"}`;
      }
      return;
    }

    if (options.kind === "action") {
      this.iconPath = new vscode.ThemeIcon("cloud-download");
      if (options.command) {
        this.command = options.command;
      }
      return;
    }

    if (options.kind === "message") {
      this.iconPath = new vscode.ThemeIcon("info");
      return;
    }

    // resource-item
    if (!item || !resource) {
      return;
    }

    this.tooltip = item.description ? `${label}\n${item.description}` : label;

    if (resource === "skills") {
      this.iconPath = new vscode.ThemeIcon("symbol-function");
      this.description = item.ref;
      this.contextValue = "mdm-skill";
    } else {
      this.iconPath = new vscode.ThemeIcon("robot");
      this.description = item.status;
      this.contextValue = "mdm-agent";
    }

    if (item.filePath) {
      this.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [vscode.Uri.file(item.filePath)]
      };
    }
  }
}

export class MdmTreeProvider implements vscode.TreeDataProvider<MdmTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    MdmTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _itemsPromise: Promise<MdmItem[]> | undefined;
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly client: MdmClient,
    private readonly resource: MdmResourceType
  ) {}

  refresh(): void {
    if (this._refreshTimer !== undefined) {
      clearTimeout(this._refreshTimer);
    }
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = undefined;
      this._itemsPromise = undefined;
      this._onDidChangeTreeData.fire();
    }, 100);
  }

  dispose(): void {
    if (this._refreshTimer !== undefined) {
      clearTimeout(this._refreshTimer);
    }
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: MdmTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: MdmTreeItem): Promise<MdmTreeItem[]> {
    if (
      element?.kind === "resource-item" ||
      element?.kind === "message" ||
      element?.kind === "action"
    ) {
      return [];
    }

    const installed = await this.client.checkInstalled();
    if (!installed) {
      return [errorItem("MDM CLI not found — check mdm.cliPath in settings")];
    }

    // Root level — always show both scope headers
    if (!element) {
      return [
        new MdmTreeItem("Global", vscode.TreeItemCollapsibleState.Expanded, {
          kind: "scope-header",
          scope: "global",
          resource: this.resource
        }),
        new MdmTreeItem("Project", vscode.TreeItemCollapsibleState.Expanded, {
          kind: "scope-header",
          scope: "project",
          resource: this.resource
        })
      ];
    }

    // Scope header children
    if (element.kind === "scope-header" && element.itemScope) {
      let items: MdmItem[];
      try {
        items = await this.fetchItems();
      } catch (err) {
        return [errorItem(err instanceof Error ? err.message : String(err))];
      }

      const scopeItems = items
        .filter((i) => i.scope === element.itemScope)
        .map((item) => this.makeItemNode(item));

      if (
        this.resource === "skills" &&
        element.itemScope === "project" &&
        scopeItems.length === 0 &&
        (await this.client.hasSkillsLockFile())
      ) {
        scopeItems.push(installPromptItem());
      }

      return scopeItems;
    }

    return [];
  }

  private makeItemNode(item: MdmItem): MdmTreeItem {
    return new MdmTreeItem(item.name, vscode.TreeItemCollapsibleState.None, {
      kind: "resource-item",
      item,
      resource: this.resource
    });
  }

  private fetchItems(): Promise<MdmItem[]> {
    if (!this._itemsPromise) {
      this._itemsPromise = this.client.listItems(this.resource);
    }
    return this._itemsPromise;
  }
}

// ---------------------------------------------------------------------------
// Rules tree
// ---------------------------------------------------------------------------

export class MdmRulesItem extends vscode.TreeItem {
  readonly kind: "rule-entry" | "message";
  readonly entry?: RulesEntry;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options:
      | { kind: "rule-entry"; entry: RulesEntry }
      | { kind: "message"; isError?: boolean }
  ) {
    super(label, collapsibleState);
    this.kind = options.kind;

    if (options.kind === "message") {
      this.iconPath = options.isError
        ? new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("problemsWarningIcon.foreground")
          )
        : new vscode.ThemeIcon("info");
      return;
    }

    // rule-entry
    const { entry } = options;
    this.entry = entry;

    if (entry.state === "linked") {
      this.iconPath = new vscode.ThemeIcon("link");
      this.description = `linked → ${entry.target ?? "AGENTS.md"}`;
      this.contextValue = "mdm-rule-linked";
      this.tooltip = `${entry.file}\nSymlink → ${entry.target ?? "AGENTS.md"}`;
    } else if (entry.state === "real") {
      this.iconPath = new vscode.ThemeIcon("file-text");
      this.description = "source file";
      this.tooltip = `${entry.file}\nThis is the AGENTS.md source of truth`;
    } else {
      // missing
      this.iconPath = new vscode.ThemeIcon("debug-disconnect");
      this.description = "not linked";
      this.contextValue = "mdm-rule-missing";
      this.tooltip = `${entry.file}\nNot yet linked to AGENTS.md`;
    }

    if (entry.state === "linked" || entry.state === "real") {
      const agentsFile = resolveAgentsMdPath(entry);
      if (agentsFile) {
        this.command = {
          command: "vscode.open",
          title: "Open AGENTS.md",
          arguments: [vscode.Uri.file(agentsFile)]
        };
      }
    }
  }
}

function resolveAgentsMdPath(entry: RulesEntry): string | undefined {
  const target =
    entry.state === "real" ? entry.file : (entry.target ?? "AGENTS.md");
  if (!target) {
    return undefined;
  }
  if (path.isAbsolute(target)) {
    return target;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return undefined;
  }
  // Symlink targets are stored relative to the symlink's own directory
  // (e.g. .github/copilot-instructions.md → ../AGENTS.md).
  const entryDir = path.dirname(path.join(root, entry.file));
  return path.resolve(entryDir, target);
}

export class MdmRulesTreeProvider implements vscode.TreeDataProvider<MdmRulesItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    MdmRulesItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _statusPromise: Promise<RulesEntry[]> | undefined;
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly client: MdmClient) {}

  refresh(): void {
    if (this._refreshTimer !== undefined) {
      clearTimeout(this._refreshTimer);
    }
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = undefined;
      this._statusPromise = undefined;
      this._onDidChangeTreeData.fire();
    }, 100);
  }

  dispose(): void {
    if (this._refreshTimer !== undefined) {
      clearTimeout(this._refreshTimer);
    }
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: MdmRulesItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: MdmRulesItem): Promise<MdmRulesItem[]> {
    if (element) {
      return [];
    }

    const installed = await this.client.checkInstalled();
    if (!installed) {
      return [
        rulesMessageItem(
          "MDM CLI not found — check mdm.cliPath in settings",
          true
        )
      ];
    }

    let entries: RulesEntry[];
    try {
      entries = await this.fetchStatus();
    } catch (err) {
      return [
        rulesMessageItem(err instanceof Error ? err.message : String(err), true)
      ];
    }

    const visible = entries.filter((e) => e.state === "linked");

    if (visible.length === 0) {
      return [
        rulesMessageItem(
          "No rules linked — use the link button above to add one"
        )
      ];
    }

    return visible.map(
      (e) =>
        new MdmRulesItem(e.file, vscode.TreeItemCollapsibleState.None, {
          kind: "rule-entry",
          entry: e
        })
    );
  }

  private fetchStatus(): Promise<RulesEntry[]> {
    if (!this._statusPromise) {
      this._statusPromise = this.client.rulesStatus();
    }
    return this._statusPromise;
  }
}

function rulesMessageItem(message: string, isError = false): MdmRulesItem {
  return new MdmRulesItem(message, vscode.TreeItemCollapsibleState.None, {
    kind: "message",
    isError
  });
}

function installPromptItem(): MdmTreeItem {
  return new MdmTreeItem(
    "Install configured project skills",
    vscode.TreeItemCollapsibleState.None,
    {
      kind: "action",
      command: { command: "mdm.installSkills", title: "Install" }
    }
  );
}

function errorItem(message: string): MdmTreeItem {
  return new MdmTreeItem(message, vscode.TreeItemCollapsibleState.None, {
    kind: "message",
    isError: true
  });
}
