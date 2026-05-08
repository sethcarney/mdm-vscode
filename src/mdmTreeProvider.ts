import * as vscode from 'vscode';
import { MdmClient, MdmItem, MdmResourceType, MdmScope } from './mdmClient';

type TreeItemKind = 'scope-header' | 'resource-item' | 'message' | 'action';

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
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      this.contextValue = 'mdm-error';
      return;
    }

    if (options.kind === 'scope-header') {
      this.iconPath = new vscode.ThemeIcon(options.scope === 'global' ? 'globe' : 'folder');
      return;
    }

    if (options.kind === 'action') {
      this.iconPath = new vscode.ThemeIcon('cloud-download');
      if (options.command) { this.command = options.command; }
      return;
    }

    if (options.kind === 'message') {
      this.iconPath = new vscode.ThemeIcon('info');
      return;
    }

    // resource-item
    if (!item || !resource) { return; }

    this.tooltip = item.description ? `${label}\n${item.description}` : label;

    if (resource === 'skills') {
      this.iconPath = new vscode.ThemeIcon('symbol-function');
      this.contextValue = 'mdm-skill';
    } else {
      this.iconPath = new vscode.ThemeIcon('robot');
      this.description = item.status;
      this.contextValue = 'mdm-agent';
    }

    if (item.filePath) {
      this.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(item.filePath)],
      };
    }
  }
}

export class MdmTreeProvider implements vscode.TreeDataProvider<MdmTreeItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<MdmTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _itemsPromise: Promise<MdmItem[]> | undefined;

  constructor(
    private readonly client: MdmClient,
    private readonly resource: MdmResourceType
  ) {}

  refresh(): void {
    this._itemsPromise = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: MdmTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: MdmTreeItem): Promise<MdmTreeItem[]> {
    if (element?.kind === 'resource-item' || element?.kind === 'message' || element?.kind === 'action') {
      return [];
    }

    const installed = await this.client.checkInstalled();
    if (!installed) {
      return [errorItem('MDM CLI not found — check mdm.cliPath in settings')];
    }

    let items: MdmItem[];
    try {
      items = await this.fetchItems();
    } catch (err) {
      return [errorItem(err instanceof Error ? err.message : String(err))];
    }

    if (element?.kind === 'scope-header' && element.itemScope) {
      return items
        .filter(i => i.scope === element.itemScope)
        .map(item => this.makeItemNode(item));
    }

    // Root level
    const hasGlobal = items.some(i => i.scope === 'global');
    const hasProject = items.some(i => i.scope === 'project');

    if (!hasGlobal && !hasProject) {
      // No skills at all — offer install if lock file is present
      if (this.resource === 'skills' && await this.client.hasSkillsLockFile()) {
        return [installPromptItem()];
      }
      return [messageItem(`No ${this.resource} found`)];
    }

    const headers: MdmTreeItem[] = [];
    if (hasGlobal) {
      headers.push(new MdmTreeItem('Global', vscode.TreeItemCollapsibleState.Expanded, { kind: 'scope-header', scope: 'global' }));
    }
    if (hasProject) {
      headers.push(new MdmTreeItem('Project', vscode.TreeItemCollapsibleState.Expanded, { kind: 'scope-header', scope: 'project' }));
    }

    // Project skills missing but lock file exists — append install prompt below existing headers
    if (this.resource === 'skills' && !hasProject && await this.client.hasSkillsLockFile()) {
      headers.push(installPromptItem());
    }

    return headers;
  }

  private makeItemNode(item: MdmItem): MdmTreeItem {
    return new MdmTreeItem(item.name, vscode.TreeItemCollapsibleState.None, {
      kind: 'resource-item',
      item,
      resource: this.resource,
    });
  }

  private fetchItems(): Promise<MdmItem[]> {
    if (!this._itemsPromise) {
      this._itemsPromise = this.client.listItems(this.resource);
    }
    return this._itemsPromise;
  }
}

function installPromptItem(): MdmTreeItem {
  return new MdmTreeItem(
    'Install configured project skills',
    vscode.TreeItemCollapsibleState.None,
    {
      kind: 'action',
      command: { command: 'mdm.installSkills', title: 'Install' },
    }
  );
}

function errorItem(message: string): MdmTreeItem {
  return new MdmTreeItem(message, vscode.TreeItemCollapsibleState.None, { kind: 'message', isError: true });
}

function messageItem(message: string): MdmTreeItem {
  return new MdmTreeItem(message, vscode.TreeItemCollapsibleState.None, { kind: 'message' });
}
