import * as vscode from 'vscode';
import { MdmClient } from './mdmClient';
import { MdmTreeProvider } from './mdmTreeProvider';

export function activate(context: vscode.ExtensionContext): void {
  const client = new MdmClient();

  const skillsProvider = new MdmTreeProvider(client, 'skills');
  const agentsProvider = new MdmTreeProvider(client, 'agents');
  const rulesProvider = new MdmTreeProvider(client, 'rules');

  context.subscriptions.push(
    vscode.window.createTreeView('mdmSkills', {
      treeDataProvider: skillsProvider,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView('mdmAgents', {
      treeDataProvider: agentsProvider,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView('mdmRules', {
      treeDataProvider: rulesProvider,
      showCollapseAll: false,
    }),

    vscode.commands.registerCommand('mdm.refreshSkills', () => skillsProvider.refresh()),
    vscode.commands.registerCommand('mdm.refreshAgents', () => agentsProvider.refresh()),
    vscode.commands.registerCommand('mdm.refreshRules', () => rulesProvider.refresh()),
    vscode.commands.registerCommand('mdm.refreshAll', () => {
      skillsProvider.refresh();
      agentsProvider.refresh();
      rulesProvider.refresh();
    }),

    vscode.commands.registerCommand('mdm.copyName', async (item: vscode.TreeItem) => {
      const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
      await vscode.env.clipboard.writeText(label);
      vscode.window.setStatusBarMessage(`Copied: ${label}`, 3000);
    }),

    // Re-probe CLI and refresh all views when the path setting changes.
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mdm.cliPath')) {
        client.clearCache();
        skillsProvider.refresh();
        agentsProvider.refresh();
        rulesProvider.refresh();
      }
    })
  );

  // Check CLI availability at activation time so the user sees the error
  // promptly rather than only when they expand a view for the first time.
  checkCliAndWarn(client);
}

function checkCliAndWarn(client: MdmClient): void {
  client.checkInstalled().then(installed => {
    if (!installed) {
      void vscode.window
        .showErrorMessage(
          'MDM CLI not found. Install it and make sure it is in your PATH, or set mdm.cliPath.',
          'Configure Path',
          'Dismiss'
        )
        .then(action => {
          if (action === 'Configure Path') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'mdm.cliPath'
            );
          }
        });
    }
  });
}

export function deactivate(): void {
  // nothing to clean up
}
