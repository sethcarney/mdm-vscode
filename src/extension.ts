import * as path from "path";
import * as vscode from "vscode";
import { MdmClient, MdmScope } from "./mdmClient";
import {
  MdmRulesItem,
  MdmRulesTreeProvider,
  MdmTreeItem,
  MdmTreeProvider
} from "./mdmTreeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const client = new MdmClient();
  const outputChannel = vscode.window.createOutputChannel("MDM");
  context.subscriptions.push(outputChannel);

  const skillsProvider = new MdmTreeProvider(client, "skills");
  const agentsProvider = new MdmTreeProvider(client, "agents");
  const rulesProvider = new MdmRulesTreeProvider(client);
  context.subscriptions.push(skillsProvider, agentsProvider, rulesProvider);

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
      skillsProvider.refresh();
      agentsProvider.refresh();
      rulesProvider.refresh();
    }),

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
          `MDM doctor failed: ${err instanceof Error ? err.message : String(err)}`
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
          `Failed to install skills: ${err instanceof Error ? err.message : String(err)}`
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
      "_mdm.addSkill#sideBar",
      async (scope?: MdmScope) => {
        const repo = await vscode.window.showInputBox({
          prompt: "GitHub repo, URL, or local path containing the skill(s)",
          placeHolder:
            "owner/repo  or  https://github.com/owner/repo  or  ./path/to/skill",
          validateInput: (v) =>
            v.trim() ? undefined : "Repository is required"
        });
        if (!repo) {
          return;
        }

        // Pre-flight audit — runs before scope picker so user decides on security first
        let skipAudit = false;
        try {
          const auditResults = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Checking security…"
            },
            () => client.preInstallAudit(repo.trim())
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
              `Security findings detected in "${repo.trim()}" (${issues.length} issue${issues.length > 1 ? "s" : ""}).`,
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

        let resolvedScope: MdmScope | undefined = scope;
        if (!resolvedScope) {
          const scopePick = await vscode.window.showQuickPick(
            [
              {
                label: "Project",
                description: "Install into the current workspace",
                scope: "project" as const
              },
              {
                label: "Global",
                description: "Install at the user level",
                scope: "global" as const
              }
            ],
            { placeHolder: "Select install scope" }
          );
          if (!scopePick) {
            return;
          }
          resolvedScope = scopePick.scope;
        }

        const ok = await installSkillWithRetry(
          client,
          repo.trim(),
          resolvedScope,
          repo.trim(),
          undefined,
          skipAudit
        );
        if (ok) {
          skillsProvider.refresh();
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.findSkill#sideBar",
      async (scope?: MdmScope) => {
        const picked = await findSkillInteractive(client);
        if (!picked) {
          return;
        }

        let source = picked.source;
        let label = picked.label;
        let skillName: string | undefined = picked.skillName || undefined;

        if (picked.localAction) {
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

        // Pre-flight audit — runs before scope picker so user decides on security first
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

        let resolvedScope: MdmScope | undefined = scope;
        if (!resolvedScope) {
          const scopePick = await vscode.window.showQuickPick(
            [
              {
                label: "Project",
                description: "Install into the current workspace",
                scope: "project" as const
              },
              {
                label: "Global",
                description: "Install at the user level",
                scope: "global" as const
              }
            ],
            { placeHolder: "Select install scope" }
          );
          if (!scopePick) {
            return;
          }
          resolvedScope = scopePick.scope;
        }

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
    ),

    vscode.commands.registerCommand(
      "_mdm.updateAllSkills#sideBar",
      async () => {
        const scopePick = await vscode.window.showQuickPick(
          [
            {
              label: "All",
              description: "Update project and global skills",
              scope: undefined as MdmScope | undefined
            },
            {
              label: "Project",
              description: "Update project skills only",
              scope: "project" as const
            },
            {
              label: "Global",
              description: "Update global skills only",
              scope: "global" as const
            }
          ],
          { placeHolder: "Which skills to update?" }
        );
        if (!scopePick) {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Updating all skills…"
            },
            () => client.updateAllSkills(scopePick.scope)
          );
          skillsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to update skills: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand("_mdm.auditSkills#sideBar", async () => {
      const scopePick = await vscode.window.showQuickPick(
        [
          {
            label: "All",
            description: "Audit project and global skills",
            scope: undefined as MdmScope | undefined
          },
          {
            label: "Project",
            description: "Audit project skills only",
            scope: "project" as const
          },
          {
            label: "Global",
            description: "Audit global skills only",
            scope: "global" as const
          }
        ],
        { placeHolder: "Which skills to audit?" }
      );
      if (!scopePick) {
        return;
      }

      let results: import("./mdmClient").AuditResult[];
      try {
        results = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Auditing skills…"
          },
          () => client.auditSkills(scopePick.scope)
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Audit failed: ${err instanceof Error ? err.message : String(err)}`
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
            `Failed to remove skill: ${err instanceof Error ? err.message : String(err)}`
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
            `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "_mdm.addAgent#sideBar",
      async (scope?: MdmScope) => {
        let resolvedScope: MdmScope | undefined = scope;
        if (!resolvedScope) {
          const scopePick = await vscode.window.showQuickPick(
            [
              {
                label: "Project",
                description: "Add to the current workspace",
                scope: "project" as const
              },
              {
                label: "Global",
                description: "Add to your user-level agent list",
                scope: "global" as const
              }
            ],
            { placeHolder: "Select scope for the new agent" }
          );
          if (!scopePick) {
            return;
          }
          resolvedScope = scopePick.scope;
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
              .map((a) => a.name.toLowerCase().replace(/\s+/g, "-"))
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
            `Failed to fetch agents: ${err instanceof Error ? err.message : String(err)}`
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
            `Failed to add agent: ${err instanceof Error ? err.message : String(err)}`
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
          `Remove agent "${name}" (${scope})?`,
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") {
          return;
        }
        try {
          const slug = name.toLowerCase().replace(/\s+/g, "-");
          await client.removeAgent(slug, scope);
          agentsProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to remove agent: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    ),

    vscode.commands.registerCommand("_mdm.rulesLinkAgent#sideBar", async () => {
      let entries: import("./mdmClient").RulesEntry[];
      try {
        entries = await client.rulesStatus();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to get rules status: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      const missing = entries.filter(
        (e) => e.state === "missing" && e.agents.length > 0
      );
      if (missing.length === 0) {
        void vscode.window.showInformationMessage(
          "All agent rules are already linked."
        );
        return;
      }

      const picks = missing.map((e) => ({
        label: e.file,
        description: e.agents.join(", "),
        entry: e
      }));

      const picked = await vscode.window.showQuickPick(picks, {
        placeHolder: "Select a rule file to link to AGENTS.md"
      });
      if (!picked) {
        return;
      }

      const agent = picked.entry.agents[0];
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Linking ${picked.entry.file}…`
          },
          () => client.rulesLink(agent)
        );
        rulesProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to link rules: ${err instanceof Error ? err.message : String(err)}`
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
            `Failed to link rules: ${err instanceof Error ? err.message : String(err)}`
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
            `Failed to unlink rules: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    ),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("mdm.cliPath")) {
        client.clearCache();
        skillsProvider.refresh();
        agentsProvider.refresh();
        rulesProvider.refresh();
      }
    })
  );

  checkCliAndWarn(client);
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
        `MDM: error checking CLI: ${err instanceof Error ? err.message : String(err)}`
      );
    });
}

export function deactivate(): void {}

interface SkillPickItem extends vscode.QuickPickItem {
  source: string;
  skillName: string;
  localAction?: true;
}

const LOCAL_PATH_ITEM: SkillPickItem = {
  label: "$(folder-opened) Install from local path…",
  description: "Enter a path to a local skill directory",
  source: "",
  skillName: "",
  localAction: true,
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
    qp.items = [LOCAL_PATH_ITEM];

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
        qp.items = [LOCAL_PATH_ITEM];
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
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return [e["stdout"], e["stderr"], e["message"]]
      .filter((v): v is string => typeof v === "string")
      .join("\n");
  }
  return String(err);
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
        `Failed to install skill: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
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
