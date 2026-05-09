import * as vscode from 'vscode';
import { MdmClient } from './mdmClient';
import { MdmTreeItem, MdmTreeProvider } from './mdmTreeProvider';

export function activate(context: vscode.ExtensionContext): void {
  const client = new MdmClient();
  const outputChannel = vscode.window.createOutputChannel('MDM');
  context.subscriptions.push(outputChannel);

  const skillsProvider = new MdmTreeProvider(client, 'skills');
  const agentsProvider = new MdmTreeProvider(client, 'agents');

  context.subscriptions.push(
    vscode.window.createTreeView('mdmSkills', {
      treeDataProvider: skillsProvider,
      showCollapseAll: true,
    }),
    vscode.window.createTreeView('mdmAgents', {
      treeDataProvider: agentsProvider,
      showCollapseAll: true,
    }),

    vscode.commands.registerCommand('mdm.refreshSkills', () => skillsProvider.refresh()),
    vscode.commands.registerCommand('mdm.refreshAgents', () => agentsProvider.refresh()),
    vscode.commands.registerCommand('mdm.refreshAll', () => {
      skillsProvider.refresh();
      agentsProvider.refresh();
    }),

    vscode.commands.registerCommand('mdm.doctor', async () => {
      try {
        const output = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Running MDM doctor…' },
          () => client.runDoctor()
        );
        outputChannel.clear();
        outputChannel.appendLine(output);
        outputChannel.show(true);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `MDM doctor failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('mdm.installSkills', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Installing project skills…' },
          () => client.installSkills()
        );
        skillsProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to install skills: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('mdm.copyName', async (item: MdmTreeItem) => {
      const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
      await vscode.env.clipboard.writeText(label);
      vscode.window.setStatusBarMessage(`Copied: ${label}`, 3000);
    }),

    vscode.commands.registerCommand('mdm.deleteSkill', async (item: MdmTreeItem) => {
      const name = item.mdmItem?.name;
      const scope = item.mdmItem?.scope ?? 'project';
      if (!name) { return; }

      const answer = await vscode.window.showWarningMessage(
        `Remove skill "${name}" (${scope})?`,
        { modal: true },
        'Remove'
      );
      if (answer !== 'Remove') { return; }

      try {
        await client.removeSkill(name, scope);
        skillsProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to remove skill: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('mdm.updateSkill', async (item: MdmTreeItem) => {
      const name = item.mdmItem?.name;
      const scope = item.mdmItem?.scope ?? 'project';
      if (!name) { return; }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Updating skill "${name}"…` },
          () => client.updateSkill(name, scope)
        );
        skillsProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('mdm.addAgent', async () => {
      const scopePick = await vscode.window.showQuickPick(
        [
          { label: 'Project', description: 'Add to the current workspace', global: false },
          { label: 'Global', description: 'Add to your user-level agent list', global: true },
        ],
        { placeHolder: 'Select scope for the new agent' }
      );
      if (!scopePick) { return; }

      let available: { label: string; description: string; agentName: string }[];
      try {
        const [allAgents, configured] = await Promise.all([
          client.listAvailableAgents(),
          client.listItems('agents'),
        ]);
        const configuredNames = new Set(
          configured
            .filter(a => a.scope === (scopePick.global ? 'global' : 'project'))
            .map(a => a.name.toLowerCase().replace(/\s+/g, '-'))
        );
        available = allAgents
          .filter(a => !configuredNames.has(a.name))
          .map(a => ({
            label: a.displayName,
            description: a.name + (a.installed ? '  ✓ installed' : ''),
            agentName: a.name,
          }));
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to fetch agents: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      if (available.length === 0) {
        void vscode.window.showInformationMessage('All known agents are already configured for this scope.');
        return;
      }

      const picked = await vscode.window.showQuickPick(available, {
        placeHolder: 'Select an agent to add',
        matchOnDescription: true,
      });
      if (!picked) { return; }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Adding agent "${picked.label}"…` },
          () => client.addAgent(picked.agentName, scopePick.global)
        );
        agentsProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to add agent: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('mdm.deleteAgent', async (item: MdmTreeItem) => {
      const name = item.mdmItem?.name;
      const scope = item.mdmItem?.scope ?? 'project';
      if (!name) { return; }
      const answer = await vscode.window.showWarningMessage(
        `Remove agent "${name}" (${scope})?`, { modal: true }, 'Remove'
      );
      if (answer !== 'Remove') { return; }
      try {
        const slug = name.toLowerCase().replace(/\s+/g, '-');
        await client.removeAgent(slug, scope === 'global');
        agentsProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to remove agent: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mdm.cliPath')) {
        client.clearCache();
        skillsProvider.refresh();
        agentsProvider.refresh();
      }
    })
  );

  checkCliAndWarn(client);
}

function checkCliAndWarn(client: MdmClient): void {
  void client.checkInstalled().then(installed => {
    if (!installed) {
      void vscode.window
        .showErrorMessage(
          'MDM CLI not found. Install it and make sure it is in your PATH, or set mdm.cliPath.',
          'Configure Path',
          'Dismiss'
        )
        .then(action => {
          if (action === 'Configure Path') {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'mdm.cliPath');
          }
        });
    }
  });
}

export function deactivate(): void {
  // nothing to clean up
}
