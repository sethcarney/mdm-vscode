import * as path from "path";
import * as vscode from "vscode";
import { MdmClient, MdmScope, stripAnsi } from "./mdmClient";
import {
  MdmLockSectionItem,
  MdmLockSectionTreeProvider,
  MdmRulesItem,
  MdmRulesTreeProvider,
  MdmTreeItem,
  MdmTreeProvider
} from "./mdmTreeProvider";

/**
 * The CLI major this extension targets. The extension and the CLI are
 * version-aligned at the major: extension 2.x drives mdm 2.x. Minors and
 * patches move independently on each side.
 */
const SUPPORTED_CLI_MAJOR = 2;

export function activate(context: vscode.ExtensionContext): void {
  const client = new MdmClient();
  const outputChannel = vscode.window.createOutputChannel("MDM");
  context.subscriptions.push(outputChannel);

  const skillsProvider = new MdmTreeProvider(client, "skills");
  const agentsProvider = new MdmTreeProvider(client, "agents");
  const rulesProvider = new MdmRulesTreeProvider(client);
  const knowledgeProvider = new MdmLockSectionTreeProvider(client, "knowledge");
  const pluginsProvider = new MdmLockSectionTreeProvider(client, "plugins");
  context.subscriptions.push(
    skillsProvider,
    agentsProvider,
    rulesProvider,
    knowledgeProvider,
    pluginsProvider
  );

  const doctorStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  doctorStatusBar.command = "mdm.doctor";
  doctorStatusBar.text = "$(pulse) MDM";
  doctorStatusBar.tooltip = "Run MDM Doctor";
  doctorStatusBar.show();
  context.subscriptions.push(doctorStatusBar);

  context.subscriptions.push(
    vscode.window.createTreeView("mdmSkills", {
      treeDataProvider: skillsProvider,
      showCollapseAll: true
    }),
    vscode.window.createTreeView("mdmAgents", {
      treeDataProvider: agentsProvider,
      showCollapseAll: true
    }),
    vscode.window.createTreeView("mdmRules", {
      treeDataProvider: rulesProvider,
      showCollapseAll: true
    }),
    vscode.window.createTreeView("mdmKnowledge", {
      treeDataProvider: knowledgeProvider
    }),
    vscode.window.createTreeView("mdmPlugins", {
      treeDataProvider: pluginsProvider
    }),

    vscode.commands.registerCommand("_mdm.refreshSkills#sideBar", () =>
      skillsProvider.refresh()
    ),
    vscode.commands.registerCommand("_mdm.refreshAgents#sideBar", () =>
      agentsProvider.refresh()
    ),
    vscode.commands.registerCommand("_mdm.refreshRules#sideBar", () =>
      rulesProvider.refresh()
    ),
    vscode.commands.registerCommand("mdm.refreshAll", () => {
      client.clearCache();
      skillsProvider.refresh();
      agentsProvider.refresh();
      rulesProvider.refresh();
      knowledgeProvider.refresh();
      pluginsProvider.refresh();
    }),
    vscode.commands.registerCommand("_mdm.refreshKnowledge#sideBar", () =>
      knowledgeProvider.refresh()
    ),
    vscode.commands.registerCommand("_mdm.refreshPlugins#sideBar", () =>
      pluginsProvider.refresh()
    ),

    vscode.commands.registerCommand(
      "_mdm.updateKnowledge#sideBar",
      (item: MdmLockSectionItem) =>
        runLockSectionAction(item, `Updating ${item.entry?.name}…`, (name) =>
          client.updateKnowledge(name)
        ).then(() => knowledgeProvider.refresh())
    ),
    vscode.commands.registerCommand(
      "_mdm.deleteKnowledge#sideBar",
      async (item: MdmLockSectionItem) => {
        const name = item.entry?.name;
        if (!name) {
          return;
        }
        const confirmed = await vscode.window.showWarningMessage(
          `Remove knowledge bundle "${name}"?`,
          { modal: true },
          "Remove"
        );
        if (confirmed !== "Remove") {
          return;
        }
        await runLockSectionAction(item, `Removing ${name}…`, (n) =>
          client.removeKnowledge(n)
        );
        knowledgeProvider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "_mdm.updatePlugin#sideBar",
      (item: MdmLockSectionItem) =>
        runLockSectionAction(item, `Updating ${item.entry?.name}…`, (name) =>
          client.updatePlugin(name)
        ).then(() => {
          pluginsProvider.refresh();
          skillsProvider.refresh();
        })
    ),
    vscode.commands.registerCommand(
      "_mdm.deletePlugin#sideBar",
      async (item: MdmLockSectionItem) => {
        const name = item.entry?.name;
        if (!name) {
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `Remove plugin "${name}"? Its skills are unlinked and its MCP servers unwired.`,
          { modal: true },
          "Remove (keep data)",
          "Remove & purge data"
        );
        if (!choice) {
          return;
        }
        await runLockSectionAction(item, `Removing ${name}…`, (n) =>
          client.removePlugin(n, choice === "Remove & purge data")
        );
        pluginsProvider.refresh();
        skillsProvider.refresh();
      }
    ),

    vscode.commands.registerCommand("mdm.migrate", () =>
      offerMigration(client, outputChannel, { manual: true })
    ),

    vscode.commands.registerCommand("mdm.doctor", async () => {
      try {
        const output = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Running MDM doctor…"
          },
          () => client.runDoctor()
        );
        outputChannel.clear();
        outputChannel.appendLine(output);
        outputChannel.show(true);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `MDM doctor failed: ${formatError(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("mdm.installSkills", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Installing project skills…"
          },
          () => client.installSkills()
        );
        skillsProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to install skills: ${formatError(err)}`
        );
      }
    }),

    vscode.commands.registerCommand(
      "_mdm.copyName#sideBar",
      async (item: MdmTreeItem) => {
        const label =
          typeof item.label === "string"
            ? item.label
            : (item.label?.label ?? "");
        await vscode.env.clipboard.writeText(label);
        vscode.window.setStatusBarMessage(`Copied: ${label}`, 3000);
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.findSkill#sideBar",
      async (context?: MdmTreeItem) => {
        const scope = context?.itemScope;
        const picked = await findSkillInteractive(client);
        if (!picked) {
          return;
        }

        let source = picked.source;
        let label = picked.label;
        let skillName: string | undefined = picked.skillName || undefined;

        if (picked.urlAction) {
          const input = await vscode.window.showInputBox({
            prompt: "GitHub repo, URL, or local path containing the skill(s)",
            placeHolder:
              "owner/repo  or  https://github.com/owner/repo  or  ./path/to/skill",
            validateInput: (v) =>
              v.trim() ? undefined : "Repository is required"
          });
          if (!input) {
            return;
          }
          source = input.trim();
          label = input.trim();
          skillName = undefined;
        } else if (picked.localAction) {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Select Skill Directory",
            title: "Select the skill directory (the one containing SKILL.md)"
          });
          if (!uris || uris.length === 0) {
            return;
          }
          source = uris[0].fsPath;
          label = path.basename(source);
          skillName = undefined;
        }

        // Discover available skills so the user can pick a subset before installing.
        // Only runs for URL/path sources where no specific skill was pre-selected.
        let selectedSkillNames: string[] | undefined;
        if (!skillName) {
          try {
            const remoteSkills = await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `Fetching skills from "${label}"…`
              },
              () => client.listRemoteSkills(source)
            );
            if (remoteSkills.length > 1) {
              const picks = await vscode.window.showQuickPick(
                remoteSkills.map((s) => ({
                  label: s.name,
                  description: s.description || undefined,
                  picked: true
                })),
                {
                  canPickMany: true,
                  title: `Skills available in "${label}"`,
                  placeHolder:
                    "Select skills to install (all selected by default)"
                }
              );
              if (!picks || picks.length === 0) {
                return;
              }
              selectedSkillNames = picks.map((p) => p.label);
            }
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Failed to list skills from "${label}": ${formatError(err)}`
            );
            return;
          }
        }

        // Pre-flight security audit — runs before scope picker so user decides on security first
        let skipAudit = false;
        try {
          const auditResults = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Checking security for "${label}"…`
            },
            () => client.preInstallAudit(source, skillName)
          );
          const issues = auditResults.flatMap((r) =>
            (r.audits ?? []).filter(
              (a) => a.status === "warn" || a.status === "fail"
            )
          );
          if (issues.length > 0) {
            const skillId = auditResults[0]?.skillId;
            const skillsShUrl = skillId
              ? `https://skills.sh/${skillId}`
              : undefined;
            const buttons: string[] = ["Install Anyway"];
            if (skillsShUrl) {
              buttons.push("View on skills.sh");
            }
            const answer = await vscode.window.showWarningMessage(
              `Security findings detected in "${label}" (${issues.length} issue${issues.length > 1 ? "s" : ""}).`,
              { modal: true },
              ...buttons
            );
            if (answer === "View on skills.sh" && skillsShUrl) {
              void vscode.env.openExternal(vscode.Uri.parse(skillsShUrl));
              return;
            }
            if (answer !== "Install Anyway") {
              return;
            }
            skipAudit = true;
          }
        } catch {
          // network failure — continue without pre-flight, let install-time audit handle it
        }

        const resolvedScope =
          scope ??
          (await pickScope({
            placeHolder: "Select install scope",
            projectDescription: "Install into the current workspace",
            globalDescription: "Install at the user level"
          }));
        if (!resolvedScope) {
          return;
        }

        if (selectedSkillNames) {
          let anyInstalled = false;
          for (const sn of selectedSkillNames) {
            const ok = await installSkillWithRetry(
              client,
              source,
              resolvedScope,
              sn,
              sn,
              skipAudit
            );
            if (ok) {
              anyInstalled = true;
            }
          }
          if (anyInstalled) {
            skillsProvider.refresh();
          }
        } else {
          const ok = await installSkillWithRetry(
            client,
            source,
            resolvedScope,
            label,
            skillName,
            skipAudit
          );
          if (ok) {
            skillsProvider.refresh();
          }
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.updateAllSkills#sideBar",
      async () => {
        const scopePick = await pickScopeOrAll({
          placeHolder: "Which skills to update?",
          allDescription: "Update project and global skills",
          projectDescription: "Update project skills only",
          globalDescription: "Update global skills only"
        });
        if (scopePick === "cancelled") {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Updating all skills…"
            },
            () => client.updateAllSkills(scopePick)
          );
          skillsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to update skills: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand("_mdm.auditSkills#sideBar", async () => {
      const scopePick = await pickScopeOrAll({
        placeHolder: "Which skills to audit?",
        allDescription: "Audit project and global skills",
        projectDescription: "Audit project skills only",
        globalDescription: "Audit global skills only"
      });
      if (scopePick === "cancelled") {
        return;
      }

      let results: import("./mdmClient").AuditResult[];
      try {
        results = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Auditing skills…"
          },
          () => client.auditSkills(scopePick)
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Audit failed: ${formatError(err)}`
        );
        return;
      }

      outputChannel.clear();
      if (results.length === 0) {
        outputChannel.appendLine("No skills to audit.");
      } else {
        for (const skill of results) {
          const sync =
            skill.syncStatus === "up-to-date"
              ? "✓"
              : skill.syncStatus === "outdated"
                ? "↑"
                : "~";
          outputChannel.appendLine(
            `${sync} ${skill.name}  [${skill.scope}]  sync: ${skill.syncStatus}`
          );
          if (skill.audits && skill.audits.length > 0) {
            for (const a of skill.audits) {
              const icon =
                a.status === "pass"
                  ? "  ✓"
                  : a.status === "fail"
                    ? "  ✗"
                    : "  !";
              const risk =
                a.riskLevel && a.riskLevel !== "NONE"
                  ? `  risk: ${a.riskLevel}`
                  : "";
              outputChannel.appendLine(
                `${icon} ${a.provider}  ${a.status}${risk}${a.summary ? `  — ${a.summary}` : ""}`
              );
            }
          }
          outputChannel.appendLine("");
        }
      }
      outputChannel.show(true);
    }),

    vscode.commands.registerCommand(
      "_mdm.deleteSkill#sideBar",
      async (item: MdmTreeItem) => {
        const name = item.mdmItem?.name;
        const scope = item.mdmItem?.scope ?? "project";
        if (!name) {
          return;
        }

        const answer = await vscode.window.showWarningMessage(
          `Remove skill "${name}" (${scope})?`,
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") {
          return;
        }

        try {
          await client.removeSkill(name, scope);
          skillsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to remove skill: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.updateSkill#sideBar",
      async (item: MdmTreeItem) => {
        const name = item.mdmItem?.name;
        const scope = item.mdmItem?.scope ?? "project";
        if (!name) {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Updating skill "${name}"…`
            },
            () => client.updateSkill(name, scope)
          );
          skillsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to update skill: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.addAgent#sideBar",
      async (context?: MdmTreeItem) => {
        const scope = context?.itemScope;
        const resolvedScope =
          scope ??
          (await pickScope({
            placeHolder: "Select scope for the new agent",
            projectDescription: "Add to the current workspace",
            globalDescription: "Add to your user-level agent list"
          }));
        if (!resolvedScope) {
          return;
        }

        let available: {
          label: string;
          description: string;
          agentName: string;
        }[];
        try {
          const [allAgents, configured] = await Promise.all([
            client.listAvailableAgents(),
            client.listItems("agents")
          ]);
          const configuredNames = new Set(
            configured
              .filter((a) => a.scope === resolvedScope)
              .map((a) => a.cliName ?? a.name)
          );
          available = allAgents
            .filter((a) => !configuredNames.has(a.name))
            .map((a) => ({
              label: a.displayName,
              description: a.name + (a.installed ? "  ✓ installed" : ""),
              agentName: a.name
            }));
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to fetch agents: ${formatError(err)}`
          );
          return;
        }

        if (available.length === 0) {
          void vscode.window.showInformationMessage(
            "All known agents are already configured for this scope."
          );
          return;
        }

        const picked = await vscode.window.showQuickPick(available, {
          placeHolder: "Select an agent to add",
          matchOnDescription: true
        });
        if (!picked) {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Adding agent "${picked.label}"…`
            },
            () => client.addAgent(picked.agentName, resolvedScope)
          );
          agentsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to add agent: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.deleteAgent#sideBar",
      async (item: MdmTreeItem) => {
        const displayName = item.mdmItem?.name;
        const cliName = item.mdmItem?.cliName ?? displayName;
        const scope = item.mdmItem?.scope ?? "project";
        if (!displayName || !cliName) {
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          `Remove agent "${displayName}" (${scope})?`,
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") {
          return;
        }
        try {
          await client.removeAgent(cliName, scope);
          agentsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to remove agent: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand("_mdm.rulesLinkAgent#sideBar", async () => {
      let entries: import("./mdmClient").RulesEntry[];
      let configured: import("./mdmClient").MdmItem[];
      try {
        [entries, configured] = await Promise.all([
          client.rulesStatus(),
          client.listItems("agents")
        ]);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to get rules status: ${formatError(err)}`
        );
        return;
      }

      const linkedAgents = new Set(
        entries.filter((e) => e.state === "linked").flatMap((e) => e.agents)
      );
      const fileByAgent = new Map<string, string>();
      for (const entry of entries) {
        if (entry.state === "linked") {
          continue;
        }
        for (const agent of entry.agents) {
          if (!fileByAgent.has(agent)) {
            fileByAgent.set(agent, entry.file);
          }
        }
      }

      interface LinkPick {
        label: string;
        description: string;
        agent: string;
      }
      const seen = new Set<string>();
      const picks: LinkPick[] = [];
      for (const item of configured) {
        const agent = item.cliName ?? item.name;
        if (linkedAgents.has(agent) || seen.has(agent)) {
          continue;
        }
        seen.add(agent);
        picks.push({
          label: item.name,
          description: fileByAgent.get(agent) ?? agent,
          agent
        });
      }

      if (picks.length === 0) {
        void vscode.window.showInformationMessage(
          "All agent rules are already linked."
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(picks, {
        placeHolder: "Select an agent to link to AGENTS.md"
      });
      if (!picked) {
        return;
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Linking ${picked.label}…`
          },
          () => client.rulesLink(picked.agent)
        );
        rulesProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to link rules: ${formatError(err)}`
        );
      }
    }),

    vscode.commands.registerCommand(
      "_mdm.rulesLink#sideBar",
      async (item: MdmRulesItem) => {
        const entry = item.entry;
        if (!entry) {
          return;
        }
        const agent = entry.agents[0];
        if (!agent) {
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Linking ${entry.file}…`
            },
            () => client.rulesLink(agent)
          );
          rulesProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to link rules: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.rulesUnlink#sideBar",
      async (item: MdmRulesItem) => {
        const entry = item.entry;
        if (!entry) {
          return;
        }
        const agent = entry.agents[0];
        if (!agent) {
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          `Unlink ${entry.file}?`,
          { modal: true },
          "Unlink"
        );
        if (answer !== "Unlink") {
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Unlinking ${entry.file}…`
            },
            () => client.rulesUnlink(agent)
          );
          rulesProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to unlink rules: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("mdm.cliPath")) {
        client.clearCache();
        void vscode.commands.executeCommand("mdm.refreshAll");
      }
    })
  );

  // Lock file edits (mdm runs in a terminal, git operations, migrations)
  // should reflect in every view without a manual refresh.
  const lockWatcher = vscode.workspace.createFileSystemWatcher(
    "**/{mdm-lock.json,skills-lock.json,knowledge-lock.json,plugins-lock.json}"
  );
  const onLockChange = (): void => {
    void vscode.commands.executeCommand("mdm.refreshAll");
  };
  lockWatcher.onDidChange(onLockChange);
  lockWatcher.onDidCreate(onLockChange);
  lockWatcher.onDidDelete(onLockChange);
  context.subscriptions.push(lockWatcher);

  checkCliAndWarn(client);
  void checkCliVersionAlignment(client);
  void offerMigration(client, outputChannel, { manual: false });
}

/**
 * The extension and the CLI are major-version aligned: extension 2.x
 * drives mdm 2.x. A CLI behind the extension gets an upgrade nudge; a CLI
 * ahead of it means the extension needs updating. Dev builds report no
 * version and are left alone.
 */
async function checkCliVersionAlignment(client: MdmClient): Promise<void> {
  if (!(await client.checkInstalled())) {
    return;
  }
  const major = await client.cliMajorVersion();
  if (major === undefined || major === SUPPORTED_CLI_MAJOR) {
    return;
  }
  if (major < SUPPORTED_CLI_MAJOR) {
    const action = await vscode.window.showWarningMessage(
      `mdm CLI v${major} detected — this extension targets v${SUPPORTED_CLI_MAJOR}. Some features (mdm-lock.json, knowledge, plugins) need the newer CLI.`,
      "Run mdm upgrade",
      "Dismiss"
    );
    if (action === "Run mdm upgrade") {
      const terminal = vscode.window.createTerminal("mdm upgrade");
      terminal.show();
      terminal.sendText("mdm upgrade");
    }
    return;
  }
  void vscode.window.showWarningMessage(
    `mdm CLI v${major} detected — this extension targets v${SUPPORTED_CLI_MAJOR}. Update the MDM extension to match.`
  );
}

/**
 * Surfaces `mdm migrate` in VS Code. On activation this only speaks up
 * when v1 lock files are actually present; the command-palette entry
 * (manual: true) always reports something.
 */
async function offerMigration(
  client: MdmClient,
  outputChannel: vscode.OutputChannel,
  opts: { manual: boolean }
): Promise<void> {
  if (!(await client.checkInstalled())) {
    return;
  }
  const major = await client.cliMajorVersion();
  if (major !== undefined && major < SUPPORTED_CLI_MAJOR) {
    // A v1 CLI has no migrate command; the version handshake already nudged.
    return;
  }
  const legacy = await client.detectLegacyLockFiles();
  if (legacy.length === 0) {
    if (opts.manual) {
      void vscode.window.showInformationMessage(
        "Nothing to migrate — no v1 lock files found."
      );
    }
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `This project has v1 lock files (${legacy.join(", ")}). Fold them into mdm-lock.json?`,
    "Migrate",
    "Migrate & delete old files",
    "Show plan"
  );
  if (!choice) {
    return;
  }
  try {
    if (choice === "Show plan") {
      const plan = await client.migrateDryRun();
      outputChannel.clear();
      outputChannel.appendLine(plan);
      outputChannel.show(true);
      return;
    }
    const output = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Migrating lock files…"
      },
      () => client.migrate(choice === "Migrate & delete old files")
    );
    outputChannel.clear();
    outputChannel.appendLine(output);
    void vscode.window.showInformationMessage(
      "Migrated to mdm-lock.json — commit it together with the removed files."
    );
    void vscode.commands.executeCommand("mdm.refreshAll");
  } catch (err) {
    void vscode.window.showErrorMessage(
      `mdm migrate failed: ${formatError(err)}`
    );
  }
}

async function runLockSectionAction(
  item: MdmLockSectionItem,
  title: string,
  action: (name: string) => Promise<void>
): Promise<void> {
  const name = item.entry?.name;
  if (!name) {
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      () => action(name)
    );
  } catch (err) {
    void vscode.window.showErrorMessage(formatError(err));
  }
}

function checkCliAndWarn(client: MdmClient): void {
  void client
    .checkInstalled()
    .then((installed) => {
      if (!installed) {
        void vscode.window
          .showErrorMessage(
            "MDM CLI not found. Install it and make sure it is in your PATH, or set mdm.cliPath.",
            "Configure Path",
            "Dismiss"
          )
          .then((action) => {
            if (action === "Configure Path") {
              void vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "mdm.cliPath"
              );
            }
          });
      }
    })
    .catch((err) => {
      void vscode.window.showErrorMessage(
        `MDM: error checking CLI: ${formatError(err)}`
      );
    });
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ScopePickerOptions {
  placeHolder: string;
  projectDescription: string;
  globalDescription: string;
}

async function pickScope(
  options: ScopePickerOptions
): Promise<MdmScope | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "Project",
        description: options.projectDescription,
        scope: "project" as const
      },
      {
        label: "Global",
        description: options.globalDescription,
        scope: "global" as const
      }
    ],
    { placeHolder: options.placeHolder }
  );
  return pick?.scope;
}

interface ScopeOrAllOptions extends ScopePickerOptions {
  allDescription: string;
}

async function pickScopeOrAll(
  options: ScopeOrAllOptions
): Promise<MdmScope | undefined | "cancelled"> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "All",
        description: options.allDescription,
        scope: undefined as MdmScope | undefined
      },
      {
        label: "Project",
        description: options.projectDescription,
        scope: "project" as const
      },
      {
        label: "Global",
        description: options.globalDescription,
        scope: "global" as const
      }
    ],
    { placeHolder: options.placeHolder }
  );
  if (!pick) {
    return "cancelled";
  }
  return pick.scope;
}

export function deactivate(): void {}

interface SkillPickItem extends vscode.QuickPickItem {
  source: string;
  skillName: string;
  localAction?: true;
  urlAction?: true;
}

const LOCAL_PATH_ITEM: SkillPickItem = {
  label: "$(folder-opened) Install from local path…",
  description: "Enter a path to a local skill directory",
  source: "",
  skillName: "",
  localAction: true,
  alwaysShow: true
};

const ENTER_URL_ITEM: SkillPickItem = {
  label: "$(repo) Enter repo URL",
  description: "owner/repo or https://…",
  source: "",
  skillName: "",
  urlAction: true,
  alwaysShow: true
};

function findSkillInteractive(
  client: MdmClient
): Promise<SkillPickItem | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<SkillPickItem>();
    qp.placeholder = "Search the skills registry (e.g. typescript, git, react)";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = [ENTER_URL_ITEM, LOCAL_PATH_ITEM];

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const settle = (value: SkillPickItem | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      qp.dispose();
      resolve(value);
    };

    qp.onDidChangeValue((value) => {
      const query = value.trim();
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      if (!query) {
        qp.items = [ENTER_URL_ITEM, LOCAL_PATH_ITEM];
        qp.busy = false;
        return;
      }
      qp.busy = true;
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void (async () => {
          try {
            const found = await client.findSkills(query);
            if (settled || query !== qp.value.trim()) {
              return;
            }
            qp.items = [
              ...found.map((r) => ({
                label: r.name,
                description: r.source + (r.stars ? `  ★${r.stars}` : ""),
                detail: r.description || undefined,
                source: r.source,
                skillName: r.name,
                alwaysShow: true
              })),
              ENTER_URL_ITEM,
              LOCAL_PATH_ITEM
            ];
          } catch {
            // ignore search errors mid-typing
          } finally {
            if (!settled && query === qp.value.trim()) {
              qp.busy = false;
            }
          }
        })();
      }, 400);
    });

    qp.onDidAccept(() => settle(qp.selectedItems[0]));
    qp.onDidHide(() => settle(undefined));
    qp.show();
  });
}

function extractErrOutput(err: unknown): string {
  let raw: string;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    raw = [e["stdout"], e["stderr"], e["message"]]
      .filter((v): v is string => typeof v === "string")
      .join("\n");
  } else {
    raw = String(err);
  }
  return stripAnsi(raw);
}

async function installSkillWithRetry(
  client: MdmClient,
  repo: string,
  scope: MdmScope,
  label: string,
  skillName?: string,
  preConfirmedSkipAudit = false
): Promise<boolean> {
  const doInstall = (
    opts: { allowHiddenChars?: boolean; skipAudit?: boolean } = {}
  ) =>
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Installing "${label}"…`
      },
      () => client.addSkill(repo, scope, skillName, opts)
    );

  const retry = async (opts: {
    allowHiddenChars?: boolean;
    skipAudit?: boolean;
  }): Promise<boolean> => {
    try {
      await doInstall(opts);
      return true;
    } catch (retryErr) {
      void vscode.window.showErrorMessage(
        `Failed to install skill: ${extractErrOutput(retryErr)}`
      );
      return false;
    }
  };

  try {
    await doInstall({ skipAudit: preConfirmedSkipAudit });
    return true;
  } catch (err) {
    const output = extractErrOutput(err);

    if (output.includes("audit-blocked")) {
      const answer = await vscode.window.showWarningMessage(
        `Security findings were detected in "${label}". Install anyway?`,
        { modal: true },
        "Install Anyway"
      );
      if (answer !== "Install Anyway") {
        return false;
      }
      return retry({ skipAudit: true });
    }

    if (output.includes("allow-hidden-chars")) {
      const answer = await vscode.window.showWarningMessage(
        `Hidden Unicode characters were detected in "${label}". Install anyway?`,
        { modal: true },
        "Install Anyway"
      );
      if (answer !== "Install Anyway") {
        return false;
      }
      return retry({ allowHiddenChars: true });
    }

    void vscode.window.showErrorMessage(`Failed to install skill: ${output}`);
    return false;
  }
}
