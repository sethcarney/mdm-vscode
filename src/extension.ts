import * as path from "path";
import * as vscode from "vscode";
import {
  InstallMode,
  MdmClient,
  MdmScope,
  PRE_RELEASE_LOCK_NAME,
  PROJECT_LOCK_NAME,
  ALL_LOCK_NAMES,
  stripAnsi
} from "./mdmClient";
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
  const harnessesProvider = new MdmTreeProvider(client, "harnesses");
  const rulesProvider = new MdmRulesTreeProvider(client);
  const knowledgeProvider = new MdmLockSectionTreeProvider(client, "knowledge");
  const pluginsProvider = new MdmLockSectionTreeProvider(client, "plugins");
  context.subscriptions.push(
    skillsProvider,
    agentsProvider,
    harnessesProvider,
    rulesProvider,
    knowledgeProvider,
    pluginsProvider
  );

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = "mdm.menu";
  statusBar.text = "$(tools) MDM";
  statusBar.tooltip = "MDM quick actions";
  statusBar.show();
  context.subscriptions.push(statusBar);

  const refreshAfterInstall = (): void => {
    // Installs touch the shared .agents tree and the lock, which the
    // scope-wide install mode header reads too.
    skillsProvider.refresh();
    agentsProvider.refresh();
  };

  context.subscriptions.push(
    vscode.window.createTreeView("mdmSkills", {
      treeDataProvider: skillsProvider,
      showCollapseAll: true
    }),
    vscode.window.createTreeView("mdmAgents", {
      treeDataProvider: agentsProvider,
      showCollapseAll: true
    }),
    vscode.window.createTreeView("mdmHarnesses", {
      treeDataProvider: harnessesProvider,
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
    vscode.commands.registerCommand("_mdm.refreshHarnesses#sideBar", () =>
      harnessesProvider.refresh()
    ),
    vscode.commands.registerCommand("_mdm.refreshRules#sideBar", () =>
      rulesProvider.refresh()
    ),
    vscode.commands.registerCommand("mdm.refreshAll", () => {
      client.clearCache();
      skillsProvider.refresh();
      agentsProvider.refresh();
      harnessesProvider.refresh();
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

    // Public, palette-visible entry points. The sidebar-internal commands
    // already prompt for anything a tree context would have provided, so
    // these are thin aliases that make every action reachable by name.
    vscode.commands.registerCommand("mdm.findSkill", () =>
      vscode.commands.executeCommand("_mdm.findSkill#sideBar")
    ),
    vscode.commands.registerCommand("mdm.updateAllSkills", () =>
      vscode.commands.executeCommand("_mdm.updateAllSkills#sideBar")
    ),
    vscode.commands.registerCommand("mdm.auditSkills", () =>
      vscode.commands.executeCommand("_mdm.auditSkills#sideBar")
    ),
    vscode.commands.registerCommand("mdm.addHarness", () =>
      vscode.commands.executeCommand("_mdm.addHarness#sideBar")
    ),
    vscode.commands.registerCommand("mdm.addAgent", () =>
      vscode.commands.executeCommand("_mdm.addAgent#sideBar")
    ),
    vscode.commands.registerCommand("mdm.updateAllAgents", () =>
      vscode.commands.executeCommand("_mdm.updateAllAgents#sideBar")
    ),
    vscode.commands.registerCommand("mdm.setInstallMode", () =>
      vscode.commands.executeCommand("_mdm.setInstallMode#sideBar")
    ),
    vscode.commands.registerCommand("mdm.linkRules", () =>
      vscode.commands.executeCommand("_mdm.rulesLinkHarness#sideBar")
    ),

    vscode.commands.registerCommand("mdm.addKnowledge", async () => {
      const source = await vscode.window.showInputBox({
        title: "Add Knowledge Bundle",
        prompt: "GitHub repo (owner/repo), URL, or local path of an OKF bundle",
        placeHolder: "acme/sales-knowledge or ./knowledge-src"
      });
      if (!source) {
        return;
      }
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Installing knowledge bundle from ${source}…`
          },
          () => client.addKnowledge(source)
        );
        knowledgeProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to add knowledge bundle: ${formatError(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("mdm.addPlugin", async () => {
      const source = await vscode.window.showInputBox({
        title: "Add Plugin",
        prompt:
          "GitHub repo (owner/repo), URL, or local path of an Agent Plugin",
        placeHolder: "acme/toolkit or ./my-plugin"
      });
      if (!source) {
        return;
      }
      const harnesses = await pickHarnesses(client, {
        title: "Install plugin for which harnesses?"
      });
      if (!harnesses) {
        return;
      }
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Installing plugin from ${source}…`
          },
          () => client.addPlugin(source, harnesses)
        );
        pluginsProvider.refresh();
        skillsProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to add plugin: ${formatError(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("mdm.installKnowledge", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Restoring knowledge bundles from lock…"
          },
          () => client.installKnowledge()
        );
        knowledgeProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(formatError(err));
      }
    }),

    vscode.commands.registerCommand("mdm.installPlugins", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Restoring plugins from lock…"
          },
          () => client.installPlugins()
        );
        pluginsProvider.refresh();
        skillsProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(formatError(err));
      }
    }),

    vscode.commands.registerCommand("mdm.installAgents", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Restoring agent definitions from lock…"
          },
          () => client.installAgentDefinitions()
        );
        agentsProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to restore agent definitions: ${formatError(err)}`
        );
      }
    }),

    // One command that restores everything the lock records: skills (which
    // restores agent definitions too), knowledge bundles, and plugins. The
    // onboarding path in one click.
    vscode.commands.registerCommand("mdm.restoreProject", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Restoring project from ${PROJECT_LOCK_NAME}…`
          },
          async (progress) => {
            progress.report({ message: "skills and agent definitions" });
            await client.installSkills();
            progress.report({ message: "knowledge bundles" });
            await client.installKnowledge();
            progress.report({ message: "plugins" });
            await client.installPlugins();
          }
        );
        void vscode.commands.executeCommand("mdm.refreshAll");
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Restore failed: ${formatError(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("mdm.openLockFile", async () => {
      const lockPath = await client.projectLockPath();
      if (!lockPath) {
        void vscode.window.showInformationMessage(
          `No ${PROJECT_LOCK_NAME} in this workspace yet. Install a skill to create one.`
        );
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(lockPath)
      );
    }),

    vscode.commands.registerCommand("mdm.menu", () => showQuickMenu(client)),

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
        // doctor exits 1 when it finds an error-level issue; the report is
        // still on stdout and is what the user asked to see.
        const report = extractErrOutput(err);
        if (report.includes("Doctor complete")) {
          outputChannel.clear();
          outputChannel.appendLine(report);
          outputChannel.show(true);
          return;
        }
        void vscode.window.showErrorMessage(
          `MDM doctor failed: ${formatError(err)}`
        );
      }
    }),

    // `mdm bug` builds a prefilled GitHub issue-form URL from the local
    // environment. Nothing is sent: the user reviews and submits the form.
    vscode.commands.registerCommand("mdm.reportBug", async () => {
      try {
        const url = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Collecting environment details for the bug report…"
          },
          () => client.bugReportUrl()
        );
        const choice = await vscode.window.showInformationMessage(
          "mdm prepared a prefilled bug-report form (version, OS, shell, detected harnesses). Nothing has been sent; review it before submitting.",
          "Open in Browser",
          "Copy URL"
        );
        if (choice === "Open in Browser") {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        } else if (choice === "Copy URL") {
          await vscode.env.clipboard.writeText(url);
          vscode.window.setStatusBarMessage("Copied bug-report URL", 3000);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Could not prepare a bug report: ${formatError(err)}`
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
        refreshAfterInstall();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to install skills: ${formatError(err)}`
        );
      }
    }),

    // The install mode (symlink or copy) is a scope-wide switch recorded
    // in the lock. `mdm skills install --copy|--symlink` is the CLI's way
    // to flip an existing scope: it re-materializes every skill and agent
    // definition already installed there, then records the mode.
    vscode.commands.registerCommand(
      "_mdm.setInstallMode#sideBar",
      async (context?: MdmTreeItem) => {
        if (context?.itemScope === "global") {
          void vscode.window.showInformationMessage(
            "The global install mode is switched from the CLI: run `mdm skills add <source> -g --copy` (or --symlink). The extension only switches the project scope."
          );
          return;
        }
        const [modes, skillCount] = await Promise.all([
          client.readInstallModes(),
          client.projectLockSkillCount()
        ]);
        if (skillCount === 0) {
          void vscode.window.showInformationMessage(
            `This project has no skills in ${PROJECT_LOCK_NAME} yet. The install mode is recorded by the first install: run \`mdm skills add <source> --copy\` to start the project in copy mode.`
          );
          return;
        }
        const current = modes.project ?? "symlink";
        const pick = await vscode.window.showQuickPick(
          [
            {
              label: "$(link) symlink",
              description:
                current === "symlink" ? "current (default)" : undefined,
              detail:
                "Harness directories link back to the canonical .agents copies. Nothing to commit but the lock.",
              mode: "symlink" as const
            },
            {
              label: "$(files) copy",
              description: current === "copy" ? "current" : undefined,
              detail:
                "Harness directories hold real copies. Use when symlinks cannot be committed or created (Windows without Developer Mode, some CI).",
              mode: "copy" as const
            }
          ],
          {
            title: "Project install mode",
            placeHolder: `Currently ${current}. Pick the mode for this project's skills and agent definitions.`
          }
        );
        if (!pick || pick.mode === current) {
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          `Switch the project to ${pick.mode} mode? Every skill and agent definition installed in this project is re-materialized as ${pick.mode === "copy" ? "a real copy" : "a symlink"}, then the mode is recorded in ${PROJECT_LOCK_NAME}.`,
          { modal: true },
          `Switch to ${pick.mode}`
        );
        if (!answer) {
          return;
        }
        await runInstallModeSwitch(client, pick.mode, refreshAfterInstall);
      }
    ),

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
          const picks = await pickRemoteSkills(client, source, label);
          if (picks === "cancelled") {
            return;
          }
          selectedSkillNames = picks;
        }

        // Pre-flight security audit runs before the scope picker so the user
        // decides on security first.
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
          // network failure: continue without pre-flight, let install-time audit handle it
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
            refreshAfterInstall();
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
            refreshAfterInstall();
          }
        }
      }
    ),

    // `mdm skills cherry-pick`: fork third-party skills into ./skills as
    // the project's own, with provenance and license recorded inside.
    // Nothing updates a fork afterwards, so it is not a lock entry.
    vscode.commands.registerCommand("mdm.cherryPickSkill", async () => {
      const source = await vscode.window.showInputBox({
        title: "Cherry-pick (Fork) Skill",
        prompt:
          "GitHub repo (owner/repo), URL, or local path holding the skill(s) to fork into ./skills",
        placeHolder: "owner/repo  or  https://github.com/owner/repo"
      });
      if (!source?.trim()) {
        return;
      }
      const trimmed = source.trim();
      const picks = await pickRemoteSkills(client, trimmed, trimmed, {
        placeHolder: "Select skills to fork (all selected by default)",
        pickEvenWhenSingle: true
      });
      if (picks === "cancelled") {
        return;
      }
      const install = await vscode.window.showQuickPick(
        [
          {
            label: "$(repo-forked) Fork only",
            detail: "Copy into ./skills with ATTRIBUTION.md; install later.",
            install: false
          },
          {
            label: "$(cloud-download) Fork and install",
            detail:
              "Also install the forks into this project's configured harnesses.",
            install: true
          }
        ],
        {
          title: "Cherry-pick",
          placeHolder: "What should happen to the forks?"
        }
      );
      if (!install) {
        return;
      }
      const runFork = (force: boolean): Thenable<string> =>
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Forking skills from ${trimmed}…`
          },
          () =>
            client.cherryPickSkills(trimmed, picks ?? [], {
              install: install.install,
              force
            })
        );
      let output: string;
      try {
        output = await runFork(false);
      } catch (err) {
        const text = extractErrOutput(err);
        if (!text.includes("--force")) {
          void vscode.window.showErrorMessage(
            `Cherry-pick failed: ${text.trim() || formatError(err)}`
          );
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          "A fork with this name already exists in ./skills. Replace it and discard local edits?",
          { modal: true },
          "Replace"
        );
        if (answer !== "Replace") {
          return;
        }
        try {
          output = await runFork(true);
        } catch (retryErr) {
          void vscode.window.showErrorMessage(
            `Cherry-pick failed: ${extractErrOutput(retryErr).trim() || formatError(retryErr)}`
          );
          return;
        }
      }
      outputChannel.clear();
      outputChannel.appendLine(output);
      outputChannel.show(true);
      if (install.install) {
        refreshAfterInstall();
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const first = picks?.[0];
      if (root && first) {
        const skillMd = vscode.Uri.joinPath(root, "skills", first, "SKILL.md");
        try {
          await vscode.workspace.fs.stat(skillMd);
          await vscode.commands.executeCommand("vscode.open", skillMd);
        } catch {
          // the fork landed under a different name; the output says where
        }
      }
    }),

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
                `${icon} ${a.provider}  ${a.status}${risk}${a.summary ? `  - ${a.summary}` : ""}`
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

    // ---- Agent definitions (mdm agents) ----------------------------------

    vscode.commands.registerCommand(
      "_mdm.addAgent#sideBar",
      async (context?: MdmTreeItem) => {
        const source = await vscode.window.showInputBox({
          title: "Add Agent Definitions",
          prompt:
            "GitHub repo (owner/repo), URL, or local path holding agent definitions (markdown with name/description frontmatter, or Codex TOML)",
          placeHolder: "owner/repo  or  ./my-agents"
        });
        if (!source?.trim()) {
          return;
        }
        const trimmed = source.trim();

        const namesInput = await vscode.window.showInputBox({
          title: "Which agent definitions?",
          prompt:
            "Comma-separated definition names to install. Leave empty to install every definition the source holds.",
          placeHolder: "code-reviewer, test-writer"
        });
        if (namesInput === undefined) {
          return;
        }
        const names = namesInput
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n.length > 0);

        const resolvedScope =
          context?.itemScope ??
          (await pickScope({
            placeHolder: "Select install scope",
            projectDescription:
              "Canonical copy in .agents/agents, linked into each harness's project agents directory",
            globalDescription:
              "Canonical copy in ~/.agents/agents, linked into each harness's user agents directory"
          }));
        if (!resolvedScope) {
          return;
        }

        const harnessChoice = await vscode.window.showQuickPick(
          [
            {
              label: "$(check) Configured harnesses",
              detail:
                "Install to the scope's configured harnesses that support agent definitions (else the detected ones).",
              choose: false
            },
            {
              label: "$(list-selection) Choose harnesses…",
              detail:
                "Pick specific harnesses. Ones without an agents directory are skipped with a notice.",
              choose: true
            }
          ],
          { title: "Install to which harnesses?" }
        );
        if (!harnessChoice) {
          return;
        }
        let harnesses: string[] | undefined;
        if (harnessChoice.choose) {
          harnesses = await pickHarnesses(client, {
            title: "Install agent definitions to which harnesses?"
          });
          if (!harnesses) {
            return;
          }
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Installing agent definitions from ${trimmed}…`
            },
            () =>
              client.addAgentDefinitions(trimmed, resolvedScope, {
                harnesses,
                names
              })
          );
          refreshAfterInstall();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to add agent definitions: ${extractErrOutput(err).trim() || formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.updateAgent#sideBar",
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
              title: `Updating agent definition "${name}"…`
            },
            () => client.updateAgentDefinition(name, scope)
          );
          agentsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to update agent definition: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.updateAllAgents#sideBar",
      async () => {
        const scopePick = await pickScopeOrAll({
          placeHolder: "Which agent definitions to update?",
          allDescription: "Update project and global agent definitions",
          projectDescription: "Update project agent definitions only",
          globalDescription: "Update global agent definitions only"
        });
        if (scopePick === "cancelled") {
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Updating agent definitions…"
            },
            () => client.updateAllAgentDefinitions(scopePick)
          );
          agentsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to update agent definitions: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.deleteAgent#sideBar",
      async (item: MdmTreeItem) => {
        const name = item.mdmItem?.name;
        const scope = item.mdmItem?.scope ?? "project";
        if (!name) {
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          `Remove agent definition "${name}" (${scope})? Its file is removed from every harness's agents directory and from the lock. A hand-written file the definition was adopted from is kept.`,
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") {
          return;
        }
        try {
          await client.removeAgentDefinition(name, scope);
          agentsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to remove agent definition: ${formatError(err)}`
          );
        }
      }
    ),

    // ---- Harnesses (mdm harnesses) ---------------------------------------

    vscode.commands.registerCommand(
      "_mdm.addHarness#sideBar",
      async (context?: MdmTreeItem) => {
        const scope = context?.itemScope;
        const resolvedScope =
          scope ??
          (await pickScope({
            placeHolder: "Select scope for the new harness",
            projectDescription: "Add to the current workspace",
            globalDescription: "Add to your user-level harness list"
          }));
        if (!resolvedScope) {
          return;
        }

        let available: {
          label: string;
          description: string;
          harnessName: string;
        }[];
        try {
          const [allHarnesses, configured] = await Promise.all([
            client.listAvailableHarnesses(),
            client.listItems("harnesses")
          ]);
          const configuredNames = new Set(
            configured
              .filter((a) => a.scope === resolvedScope)
              .map((a) => a.cliName ?? a.name)
          );
          available = allHarnesses
            .filter((a) => !configuredNames.has(a.name))
            .map((a) => ({
              label: a.displayName,
              description: a.name + (a.installed ? "  ✓ installed" : ""),
              harnessName: a.name
            }));
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to fetch harnesses: ${formatError(err)}`
          );
          return;
        }

        if (available.length === 0) {
          void vscode.window.showInformationMessage(
            "All known harnesses are already configured for this scope."
          );
          return;
        }

        const picked = await vscode.window.showQuickPick(available, {
          placeHolder: "Select a harness to add",
          matchOnDescription: true
        });
        if (!picked) {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Adding harness "${picked.label}"…`
            },
            () => client.addHarness(picked.harnessName, resolvedScope)
          );
          harnessesProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to add harness: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.deleteHarness#sideBar",
      async (item: MdmTreeItem) => {
        const displayName = item.mdmItem?.name;
        const cliName = item.mdmItem?.cliName ?? displayName;
        const scope = item.mdmItem?.scope ?? "project";
        if (!displayName || !cliName) {
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          `Remove harness "${displayName}" (${scope})? mdm also deletes the files that belong only to it: its skills directory and its instruction file. The shared .agents/skills and AGENTS.md are never touched.`,
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") {
          return;
        }
        try {
          await client.removeHarness(cliName, scope);
          harnessesProvider.refresh();
          skillsProvider.refresh();
          rulesProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to remove harness: ${formatError(err)}`
          );
        }
      }
    ),

    // ---- Rules -----------------------------------------------------------

    vscode.commands.registerCommand(
      "_mdm.rulesLinkHarness#sideBar",
      async () => {
        let entries: import("./mdmClient").RulesEntry[];
        let configured: import("./mdmClient").MdmItem[];
        try {
          [entries, configured] = await Promise.all([
            client.rulesStatus(),
            client.listItems("harnesses")
          ]);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to get rules status: ${formatError(err)}`
          );
          return;
        }

        const linkedHarnesses = new Set(
          entries.filter((e) => e.state === "linked").flatMap((e) => e.agents)
        );
        const fileByHarness = new Map<string, string>();
        for (const entry of entries) {
          if (entry.state === "linked") {
            continue;
          }
          for (const harness of entry.agents) {
            if (!fileByHarness.has(harness)) {
              fileByHarness.set(harness, entry.file);
            }
          }
        }

        interface LinkPick {
          label: string;
          description: string;
          harness: string;
        }
        const seen = new Set<string>();
        const picks: LinkPick[] = [];
        for (const item of configured) {
          const harness = item.cliName ?? item.name;
          if (linkedHarnesses.has(harness) || seen.has(harness)) {
            continue;
          }
          seen.add(harness);
          picks.push({
            label: item.name,
            description: fileByHarness.get(harness) ?? harness,
            harness
          });
        }

        if (picks.length === 0) {
          void vscode.window.showInformationMessage(
            "All harness rules are already linked."
          );
          return;
        }

        const picked = await vscode.window.showQuickPick(picks, {
          placeHolder: "Select a harness to link to AGENTS.md"
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
            () => client.rulesLink(picked.harness)
          );
          rulesProvider.refresh();
          harnessesProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to link rules: ${formatError(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.rulesLink#sideBar",
      async (item: MdmRulesItem) => {
        const entry = item.entry;
        if (!entry) {
          return;
        }
        const harness = entry.agents[0];
        if (!harness) {
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Linking ${entry.file}…`
            },
            () => client.rulesLink(harness)
          );
          rulesProvider.refresh();
          harnessesProvider.refresh();
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
        const harness = entry.agents[0];
        if (!harness) {
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
            () => client.rulesUnlink(harness)
          );
          rulesProvider.refresh();
          harnessesProvider.refresh();
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
    `**/{${ALL_LOCK_NAMES.join(",")}}`
  );
  const onLockChange = (): void => {
    void vscode.commands.executeCommand("mdm.refreshAll");
  };
  lockWatcher.onDidChange(onLockChange);
  lockWatcher.onDidCreate(onLockChange);
  lockWatcher.onDidDelete(onLockChange);
  context.subscriptions.push(lockWatcher);

  // The canonical .agents tree changes when mdm installs, updates, or
  // removes anything; the agent definitions view reads it directly.
  const agentsWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.agents/agents/*.{md,toml}"
  );
  const onAgentsChange = (): void => agentsProvider.refresh();
  agentsWatcher.onDidChange(onAgentsChange);
  agentsWatcher.onDidCreate(onAgentsChange);
  agentsWatcher.onDidDelete(onAgentsChange);
  context.subscriptions.push(agentsWatcher);

  const refreshContexts = (): void => {
    void updateViewContexts(client);
  };
  refreshContexts();
  lockWatcher.onDidChange(refreshContexts);
  lockWatcher.onDidCreate(refreshContexts);
  lockWatcher.onDidDelete(refreshContexts);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("mdm.cliPath")) {
        refreshContexts();
      }
    })
  );

  checkCliAndWarn(client);
  void checkCliVersionAlignment(client);
  void offerPreReleaseLockRename(client);
  void offerMigration(client, outputChannel, { manual: false });
}

/**
 * Context keys the viewsWelcome contributions key off: whether the CLI is
 * reachable, and whether the project has a lock file to restore from.
 */
async function updateViewContexts(client: MdmClient): Promise<void> {
  const [installed, hasLock] = await Promise.all([
    client.checkInstalled(),
    client.hasProjectLockFile()
  ]);
  await Promise.all([
    vscode.commands.executeCommand("setContext", "mdm.cliMissing", !installed),
    vscode.commands.executeCommand(
      "setContext",
      "mdm.projectLockPresent",
      hasLock
    )
  ]);
}

interface QuickMenuEntry extends vscode.QuickPickItem {
  command?: string;
}

/**
 * The status-bar hub: every mdm action, one click away, grouped the way
 * the CLI groups them. Each entry defers to the same command the views
 * and palette use.
 */
async function showQuickMenu(client: MdmClient): Promise<void> {
  const installed = await client.checkInstalled();
  if (!installed) {
    const action = await vscode.window.showErrorMessage(
      "MDM CLI not found. Install it and make sure it is in your PATH, or set mdm.cliPath.",
      "Configure Path"
    );
    if (action === "Configure Path") {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "mdm.cliPath"
      );
    }
    return;
  }
  const entries: QuickMenuEntry[] = [
    { label: "Skills", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(search) Find & install a skill",
      command: "mdm.findSkill"
    },
    { label: "$(sync) Update all skills", command: "mdm.updateAllSkills" },
    { label: "$(shield) Audit skills", command: "mdm.auditSkills" },
    {
      label: "$(repo-forked) Cherry-pick (fork) a skill",
      description: "into ./skills as your own",
      command: "mdm.cherryPickSkill"
    },
    {
      label: "$(settings) Set project install mode",
      description: "symlink or copy",
      command: "mdm.setInstallMode"
    },
    { label: "Agent definitions", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(robot) Add agent definitions",
      description: "subagent personas from a repo or path",
      command: "mdm.addAgent"
    },
    {
      label: "$(sync) Update agent definitions",
      command: "mdm.updateAllAgents"
    },
    { label: "Knowledge & Plugins", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(book) Add knowledge bundle", command: "mdm.addKnowledge" },
    { label: "$(plug) Add plugin", command: "mdm.addPlugin" },
    { label: "Harnesses & Rules", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(terminal) Add harness",
      description: "Claude Code, Cursor, Copilot, …",
      command: "mdm.addHarness"
    },
    { label: "$(link) Link harness rules", command: "mdm.linkRules" },
    { label: "Project", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(cloud-download) Restore project from lock",
      description: "skills + agent definitions + knowledge + plugins",
      command: "mdm.restoreProject"
    },
    { label: "$(pulse) Run doctor", command: "mdm.doctor" },
    { label: "$(arrow-right) Migrate v1 lock files", command: "mdm.migrate" },
    {
      label: `$(go-to-file) Open ${PROJECT_LOCK_NAME}`,
      command: "mdm.openLockFile"
    },
    { label: "$(refresh) Refresh all views", command: "mdm.refreshAll" },
    { label: "$(bug) Report a bug", command: "mdm.reportBug" }
  ];
  const picked = await vscode.window.showQuickPick(entries, {
    title: "MDM",
    placeHolder: "Pick an action"
  });
  if (picked?.command) {
    void vscode.commands.executeCommand(picked.command);
  }
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
      `mdm CLI v${major} detected. This extension targets v${SUPPORTED_CLI_MAJOR}: ${PROJECT_LOCK_NAME}, agent definitions, harnesses, knowledge, and plugins need the newer CLI.`,
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
    `mdm CLI v${major} detected. This extension targets v${SUPPORTED_CLI_MAJOR}: update the MDM extension to match.`
  );
}

/**
 * Pre-release v2 builds wrote the unified lock as mdm-lock.json. The
 * released CLI only reads mdm.lock (the content is the same JSON), so a
 * project that still carries the old name silently has no lock. Offer the
 * rename; the user confirms it.
 */
async function offerPreReleaseLockRename(client: MdmClient): Promise<void> {
  if (!(await client.hasPreReleaseLockFile())) {
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `This project has ${PRE_RELEASE_LOCK_NAME}, the pre-release name of the v2 lock. mdm v2 now reads ${PROJECT_LOCK_NAME} (same JSON content), so the file is currently ignored.`,
    `Rename to ${PROJECT_LOCK_NAME}`,
    "Dismiss"
  );
  if (choice !== `Rename to ${PROJECT_LOCK_NAME}`) {
    return;
  }
  try {
    await vscode.workspace.fs.rename(
      vscode.Uri.joinPath(root, PRE_RELEASE_LOCK_NAME),
      vscode.Uri.joinPath(root, PROJECT_LOCK_NAME),
      { overwrite: false }
    );
    void vscode.window.showInformationMessage(
      `Renamed to ${PROJECT_LOCK_NAME}. Commit the rename so teammates pick it up.`
    );
    void vscode.commands.executeCommand("mdm.refreshAll");
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not rename the lock file: ${formatError(err)}`
    );
  }
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
        "Nothing to migrate: no v1 lock files found."
      );
    }
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `This project has v1 lock files (${legacy.join(", ")}). Fold them into ${PROJECT_LOCK_NAME}? Migration also records the scope's install mode (symlink or copy) from what is on disk.`,
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
    const deleteOldFiles = choice === "Migrate & delete old files";
    const runMigrate = (force: boolean): Thenable<string> =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Migrating lock files…"
        },
        () => client.migrate({ deleteOldFiles, force })
      );
    let output: string;
    try {
      output = await runMigrate(false);
    } catch (err) {
      // An existing mdm.lock that lacks entries the v1 files still hold:
      // the CLI refuses to drop them without --force. Show what would go.
      const text = extractErrOutput(err);
      if (!text.includes("--force")) {
        throw err;
      }
      outputChannel.clear();
      outputChannel.appendLine(text);
      outputChannel.show(true);
      const answer = await vscode.window.showWarningMessage(
        `Some v1 lock entries are missing from the existing ${PROJECT_LOCK_NAME} (listed in the MDM output). Discard them and migrate anyway? Re-add them afterwards with mdm skills/knowledge/plugins add if they were removed by mistake.`,
        { modal: true },
        "Discard & migrate"
      );
      if (answer !== "Discard & migrate") {
        return;
      }
      output = await runMigrate(true);
    }
    outputChannel.clear();
    outputChannel.appendLine(output);
    void vscode.window.showInformationMessage(
      `Migrated to ${PROJECT_LOCK_NAME}. Commit it together with the removed files.`
    );
    void vscode.commands.executeCommand("mdm.refreshAll");
  } catch (err) {
    void vscode.window.showErrorMessage(
      `mdm migrate failed: ${extractErrOutput(err).trim() || formatError(err)}`
    );
  }
}

async function runInstallModeSwitch(
  client: MdmClient,
  mode: InstallMode,
  onDone: () => void
): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Switching the project to ${mode} mode…`
      },
      () => client.installSkills(mode)
    );
    onDone();
    void vscode.window.showInformationMessage(
      `Project install mode is now ${mode} (recorded in ${PROJECT_LOCK_NAME}).`
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not switch the install mode: ${extractErrOutput(err).trim() || formatError(err)}`
    );
  }
}

/**
 * A multi-select over every harness mdm knows, with the ones detected on
 * this machine pre-checked. Returns undefined when the user cancels.
 */
async function pickHarnesses(
  client: MdmClient,
  opts: { title: string }
): Promise<string[] | undefined> {
  let known: import("./mdmClient").KnownHarness[];
  try {
    known = await client.listAvailableHarnesses();
  } catch (err) {
    void vscode.window.showErrorMessage(formatError(err));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    known.map((a) => ({
      label: a.displayName,
      description: a.name,
      picked: a.installed
    })),
    { title: opts.title, canPickMany: true, matchOnDescription: true }
  );
  if (!picked || picked.length === 0) {
    return undefined;
  }
  return picked.map((p) => p.description);
}

/**
 * Lists the skills a source holds (`mdm skills find --source`) and lets the
 * user pick a subset. Returns undefined when the source holds a single
 * skill (or none listable) and no picker is needed, the chosen names
 * otherwise, and "cancelled" when the user backs out.
 */
async function pickRemoteSkills(
  client: MdmClient,
  source: string,
  label: string,
  opts: { placeHolder?: string; pickEvenWhenSingle?: boolean } = {}
): Promise<string[] | undefined | "cancelled"> {
  let remoteSkills: import("./mdmClient").RemoteSkillEntry[];
  try {
    remoteSkills = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Fetching skills from "${label}"…`
      },
      () => client.listRemoteSkills(source)
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to list skills from "${label}": ${formatError(err)}`
    );
    return "cancelled";
  }
  if (remoteSkills.length === 0) {
    return undefined;
  }
  if (remoteSkills.length === 1 && !opts.pickEvenWhenSingle) {
    return undefined;
  }
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
        opts.placeHolder ?? "Select skills to install (all selected by default)"
    }
  );
  if (!picks || picks.length === 0) {
    return "cancelled";
  }
  return picks.map((p) => p.label);
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
