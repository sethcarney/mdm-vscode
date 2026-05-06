import * as vscode from 'vscode';
import { MdmClient, MdmItem, MdmResourceType } from './mdmClient';

const ICON_BY_RESOURCE: Record<MdmResourceType, string> = {
  skills: 'symbol-function',
  agents: 'robot',
  rules: 'law',
};

export class MdmTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options: { item?: MdmItem; isError?: boolean; resource?: MdmResourceType } = {}
  ) {
    super(label, collapsibleState);

    const { item, isError = false, resource } = options;

    if (item?.description) {
      this.description = item.description;
    }
    this.tooltip = item?.description ? `${label}\n${item.description}` : label;

    if (isError) {
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('problemsWarningIcon.foreground')
      );
      this.contextValue = 'mdm-error';
    } else if (item && resource) {
      this.iconPath = new vscode.ThemeIcon(ICON_BY_RESOURCE[resource]);
      this.contextValue = 'mdm-item';
    } else {
      this.iconPath = new vscode.ThemeIcon('info');
    }
  }
}

export class MdmTreeProvider implements vscode.TreeDataProvider<MdmTreeItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<MdmTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly client: MdmClient,
    private readonly resource: MdmResourceType
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: MdmTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: MdmTreeItem): Promise<MdmTreeItem[]> {
    if (element) {
      return [];
    }

    const installed = await this.client.checkInstalled();
    if (!installed) {
      return [
        new MdmTreeItem(
          'MDM CLI not found — check mdm.cliPath in settings',
          vscode.TreeItemCollapsibleState.None,
          { isError: true }
        ),
      ];
    }

    try {
      const items = await this.client.listItems(this.resource);
      if (items.length === 0) {
        return [
          new MdmTreeItem(
            `No ${this.resource} found`,
            vscode.TreeItemCollapsibleState.None
          ),
        ];
      }
      return items.map(
        item =>
          new MdmTreeItem(item.name, vscode.TreeItemCollapsibleState.None, {
            item,
            resource: this.resource,
          })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [
        new MdmTreeItem(message, vscode.TreeItemCollapsibleState.None, { isError: true }),
      ];
    }
  }
}
