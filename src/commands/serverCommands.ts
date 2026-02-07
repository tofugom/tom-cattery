import * as vscode from 'vscode';
import { TomcatInstance, PortConfig, Deployment } from '../types';
import { ServerTreeProvider, ServerTreeItem, DeploymentTreeItem } from '../views/ServerTreeProvider';
import { ConfigWebviewProvider } from '../views/ConfigWebviewProvider';
import { RuntimeManager } from '../core/RuntimeManager';
import { InstanceManager } from '../core/InstanceManager';
import { ProcessManager } from '../core/ProcessManager';
import { LogStreamer } from '../core/LogStreamer';
import { DeployManager } from '../core/DeployManager';
import { DebugController } from '../core/DebugController';

async function pickServer(
  instanceManager: InstanceManager,
  filter?: (i: TomcatInstance) => boolean,
): Promise<TomcatInstance | undefined> {
  let servers = instanceManager.getInstances();
  if (filter) {
    servers = servers.filter(filter);
  }
  if (servers.length === 0) {
    vscode.window.showInformationMessage('No matching servers.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    servers.map(s => ({ label: s.name, description: `:${s.ports.http} (${s.status})`, instance: s })),
    { placeHolder: 'Select server' },
  );
  return picked?.instance;
}

export function registerServerCommands(
  context: vscode.ExtensionContext,
  treeProvider: ServerTreeProvider,
  runtimeManager: RuntimeManager,
  instanceManager: InstanceManager,
  processManager: ProcessManager,
  logStreamer: LogStreamer,
  deployManager: DeployManager,
  debugController: DebugController,
  configWebviewProvider: ConfigWebviewProvider,
): void {
  context.subscriptions.push(
    // ── Add Server ──
    vscode.commands.registerCommand('tomCattery.addServer', async () => {
      try {
        // 1. Select runtime
        const runtimes = runtimeManager.getRuntimes();
        let selectedRuntime;

        if (runtimes.length === 0) {
          const action = await vscode.window.showInformationMessage(
            'No Tomcat runtime registered. Select a Tomcat installation directory.',
            'Browse',
          );
          if (action !== 'Browse') {
            return;
          }
          selectedRuntime = await runtimeManager.addRuntime();
        } else {
          const items = [
            ...runtimes.map(r => ({
              label: `Apache Tomcat ${r.version}`,
              description: r.path,
              runtime: r,
            })),
            { label: '$(add) Add New Runtime...', description: '', runtime: undefined as any },
          ];
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Tomcat Runtime',
          });
          if (!picked) {
            return;
          }
          selectedRuntime = picked.runtime ?? await runtimeManager.addRuntime();
        }

        if (!selectedRuntime) {
          return;
        }

        // 2. Enter server name
        const name = await vscode.window.showInputBox({
          prompt: 'Enter server name',
          placeHolder: 'my-web-app',
          validateInput: (value) => {
            if (!value?.trim()) {
              return 'Server name is required';
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
              return 'Only alphanumeric characters, hyphens, and underscores allowed';
            }
            if (instanceManager.getInstances().some(i => i.name === value)) {
              return 'Server name already exists';
            }
            return undefined;
          },
        });
        if (!name) {
          return;
        }

        // 3. Enter HTTP port
        const httpPortStr = await vscode.window.showInputBox({
          prompt: 'HTTP Port (other ports will be derived automatically)',
          value: '8080',
          validateInput: (v) => {
            const n = parseInt(v);
            if (isNaN(n) || n < 1 || n > 65535) {
              return 'Port must be between 1 and 65535';
            }
            return undefined;
          },
        });
        if (!httpPortStr) {
          return;
        }

        const httpPort = parseInt(httpPortStr);
        const ports: PortConfig = {
          http: httpPort,
          https: httpPort + 363,
          shutdown: httpPort - 75,
          ajp: httpPort - 71,
          debug: httpPort - 80,
        };

        // 4. JAVA_HOME
        let javaHome = process.env.JAVA_HOME || '';
        if (!javaHome) {
          const javaUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select JAVA_HOME directory',
          });
          if (javaUri && javaUri.length > 0) {
            javaHome = javaUri[0].fsPath;
          }
        }

        // 5. Create instance
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Creating server "${name}"...` },
          async () => {
            await instanceManager.createInstance(name, selectedRuntime, ports, javaHome);
          },
        );

        treeProvider.setServers(instanceManager.getInstances());
        vscode.window.showInformationMessage(
          `Server "${name}" created (HTTP:${ports.http}, Shutdown:${ports.shutdown}).`,
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create server: ${err.message}`);
      }
    }),

    // ── Add Runtime ──
    vscode.commands.registerCommand('tomCattery.addRuntime', async () => {
      await runtimeManager.addRuntime();
    }),

    // ── Start Server ──
    vscode.commands.registerCommand('tomCattery.startServer', async (item?: ServerTreeItem) => {
      const instance = item?.instance ?? await pickServer(instanceManager, i => i.status === 'stopped');
      if (!instance) {
        return;
      }
      try {
        await processManager.startServer(instance);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to start server: ${err.message}`);
      }
    }),

    // ── Stop Server ──
    vscode.commands.registerCommand('tomCattery.stopServer', async (item?: ServerTreeItem) => {
      const instance = item?.instance ?? await pickServer(instanceManager, i => i.status === 'running' || i.status === 'debugging');
      if (!instance) {
        return;
      }
      try {
        await processManager.stopServer(instance);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to stop server: ${err.message}`);
      }
    }),

    // ── Restart Server ──
    vscode.commands.registerCommand('tomCattery.restartServer', async (item?: ServerTreeItem) => {
      const instance = item?.instance ?? await pickServer(instanceManager, i => i.status === 'running' || i.status === 'debugging');
      if (!instance) {
        return;
      }
      try {
        await processManager.restartServer(instance);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to restart server: ${err.message}`);
      }
    }),

    // ── Debug Server ──
    vscode.commands.registerCommand('tomCattery.debugServer', async (item?: ServerTreeItem) => {
      const instance = item?.instance ?? await pickServer(instanceManager, i => i.status === 'stopped');
      if (!instance) {
        return;
      }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Starting debug for "${instance.name}"...`, cancellable: false },
          () => debugController.debugServer(instance),
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Debug failed: ${err.message}`);
      }
    }),

    // ── Add Deployment (config only, no deploy) ──
    vscode.commands.registerCommand('tomCattery.addDeployment', async (item?: ServerTreeItem) => {
      const instance = item?.instance ?? await pickServer(instanceManager);
      if (!instance) {
        return;
      }

      try {
        // 1. Select WAR file
        const warUris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'WAR files': ['war'] },
          openLabel: 'Select WAR file',
        });
        if (!warUris || warUris.length === 0) {
          return;
        }

        const warPath = warUris[0].fsPath;

        // 2. Context path
        const contextPath = await vscode.window.showInputBox({
          prompt: 'Context Path (e.g., / for ROOT, /api for api)',
          value: `/${instance.name}`,
          validateInput: (v) => {
            if (!v.startsWith('/') && v !== '') {
              return 'Context path must start with /';
            }
            return undefined;
          },
        });
        if (contextPath === undefined) {
          return;
        }

        // 3. Optional: Gradle build task
        const buildTask = await vscode.window.showInputBox({
          prompt: 'Gradle build task (optional, e.g., :web-app:war). Leave empty to skip.',
          placeHolder: ':module:war',
        });

        const deploymentName = contextPath === '/'
          ? 'ROOT'
          : contextPath.replace(/^\//, '').replace(/\//g, '-');

        // Infer watchPaths from WAR path
        const watchPaths = deployManager.inferWatchPaths(warPath);

        const deployment: Deployment = {
          name: deploymentName,
          type: buildTask ? 'gradle' : 'war',
          buildTask: buildTask || undefined,
          warPath,
          contextPath: contextPath || '/',
          autoDeploy: false,
          watchPaths: watchPaths.length > 0 ? watchPaths : undefined,
        };

        // Save deployment config only
        await instanceManager.addDeployment(instance.name, deployment);
        treeProvider.setServers(instanceManager.getInstances());
        vscode.window.showInformationMessage(
          `Deployment "${deploymentName}" added to "${instance.name}" (${deployment.contextPath}).`,
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to add deployment: ${err.message}`);
      }
    }),

    // ── Deploy (execute deployment) ──
    vscode.commands.registerCommand('tomCattery.deploy', async (item?: DeploymentTreeItem) => {
      let instance: TomcatInstance;
      let deployment: Deployment;

      if (item instanceof DeploymentTreeItem) {
        // Called from deployment tree item
        instance = item.instance;
        deployment = item.deployment;
      } else {
        // Called from command palette — pick server then deployment
        const server = await pickServer(instanceManager);
        if (!server) {
          return;
        }
        if (server.deployments.length === 0) {
          vscode.window.showInformationMessage(`No deployments configured for "${server.name}". Use "Add Deployment" first.`);
          return;
        }
        const depItems = server.deployments.map(d => ({
          label: d.name,
          description: `${d.contextPath} → ${deployManager.contextPathToDir(d.contextPath)}/`,
          deployment: d,
        }));
        const picked = await vscode.window.showQuickPick(depItems, {
          placeHolder: 'Select deployment to execute',
        });
        if (!picked) {
          return;
        }
        instance = server;
        deployment = picked.deployment;
      }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Deploying ${deployment.name}...` },
          () => deployManager.deploy(instance, deployment),
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Deploy failed: ${err.message}`);
      }
    }),

    // ── Redeploy All ──
    vscode.commands.registerCommand('tomCattery.redeployAll', async (item?: ServerTreeItem) => {
      const instance = item?.instance ?? await pickServer(instanceManager);
      if (!instance) {
        return;
      }
      if (instance.deployments.length === 0) {
        vscode.window.showInformationMessage(`No deployments configured for "${instance.name}".`);
        return;
      }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Redeploying all to "${instance.name}"...` },
          () => deployManager.redeployAll(instance),
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Redeploy failed: ${err.message}`);
      }
    }),

    // ── Clean Deployment ──
    vscode.commands.registerCommand('tomCattery.cleanDeployment', async (item?: DeploymentTreeItem | ServerTreeItem) => {
      if (item instanceof DeploymentTreeItem) {
        // Called from deployment tree item — clean single deployment directly
        const confirm = await vscode.window.showWarningMessage(
          `Remove deployment "${item.deployment.name}" (${item.deployment.contextPath})?`,
          { modal: true },
          'Clean',
        );
        if (confirm !== 'Clean') {
          return;
        }
        try {
          await deployManager.cleanDeployment(item.instance, item.deployment);
          await instanceManager.removeDeployment(item.instance.name, item.deployment.contextPath);
          treeProvider.setServers(instanceManager.getInstances());
          vscode.window.showInformationMessage(`Deployment "${item.deployment.name}" cleaned.`);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Clean failed: ${err.message}`);
        }
        return;
      }

      // Called from server tree item or command palette — show picker
      const instance = (item instanceof ServerTreeItem ? item.instance : undefined) ?? await pickServer(instanceManager);
      if (!instance) {
        return;
      }
      if (instance.deployments.length === 0) {
        vscode.window.showInformationMessage(`No deployments configured for "${instance.name}".`);
        return;
      }

      const choices = [
        { label: '$(trash) Clean All Deployments', value: '__all__' },
        ...instance.deployments.map(d => ({
          label: d.name,
          description: `${d.contextPath} → ${deployManager.contextPathToDir(d.contextPath)}/`,
          value: d.contextPath,
        })),
      ];

      const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: `Select deployment to clean from "${instance.name}"`,
      });
      if (!picked) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        picked.value === '__all__'
          ? `Remove all deployments from "${instance.name}"?`
          : `Remove deployment "${picked.label}" (${picked.value})?`,
        { modal: true },
        'Clean',
      );
      if (confirm !== 'Clean') {
        return;
      }

      try {
        if (picked.value === '__all__') {
          for (const dep of [...instance.deployments]) {
            await deployManager.cleanDeployment(instance, dep);
            await instanceManager.removeDeployment(instance.name, dep.contextPath);
          }
          vscode.window.showInformationMessage(`All deployments cleaned from "${instance.name}".`);
        } else {
          const dep = instance.deployments.find(d => d.contextPath === picked.value)!;
          await deployManager.cleanDeployment(instance, dep);
          await instanceManager.removeDeployment(instance.name, dep.contextPath);
          vscode.window.showInformationMessage(`Deployment "${picked.label}" cleaned from "${instance.name}".`);
        }
        treeProvider.setServers(instanceManager.getInstances());
      } catch (err: any) {
        vscode.window.showErrorMessage(`Clean failed: ${err.message}`);
      }
    }),

    // ── Edit Deployment ──
    vscode.commands.registerCommand('tomCattery.editDeployment', async (item?: DeploymentTreeItem) => {
      if (!(item instanceof DeploymentTreeItem)) {
        return;
      }
      const dep = item.deployment;
      const instance = item.instance;

      const fields = [
        { label: 'Context Path', description: dep.contextPath, value: 'contextPath' },
        { label: 'WAR Path', description: dep.warPath, value: 'warPath' },
        { label: 'Build Task', description: dep.buildTask || '(none)', value: 'buildTask' },
      ];

      const picked = await vscode.window.showQuickPick(fields, {
        placeHolder: `Edit deployment "${dep.name}"`,
      });
      if (!picked) {
        return;
      }

      try {
        if (picked.value === 'contextPath') {
          const newValue = await vscode.window.showInputBox({
            prompt: 'Context Path',
            value: dep.contextPath,
            validateInput: (v) => {
              if (!v.startsWith('/') && v !== '') {
                return 'Context path must start with /';
              }
              return undefined;
            },
          });
          if (newValue === undefined) {
            return;
          }
          // Remove old, add with new context path
          await instanceManager.removeDeployment(instance.name, dep.contextPath);
          const newName = newValue === '/'
            ? 'ROOT'
            : newValue.replace(/^\//, '').replace(/\//g, '-');
          const updated: Deployment = { ...dep, contextPath: newValue || '/', name: newName };
          await instanceManager.addDeployment(instance.name, updated);
        } else if (picked.value === 'warPath') {
          const warUris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'WAR files': ['war'] },
            openLabel: 'Select WAR file',
          });
          if (!warUris || warUris.length === 0) {
            return;
          }
          dep.warPath = warUris[0].fsPath;
          await instanceManager.addDeployment(instance.name, dep);
        } else if (picked.value === 'buildTask') {
          const newValue = await vscode.window.showInputBox({
            prompt: 'Gradle build task (leave empty to remove)',
            value: dep.buildTask || '',
            placeHolder: ':module:war',
          });
          if (newValue === undefined) {
            return;
          }
          dep.buildTask = newValue || undefined;
          dep.type = newValue ? 'gradle' : 'war';
          await instanceManager.addDeployment(instance.name, dep);
        }

        treeProvider.setServers(instanceManager.getInstances());
        vscode.window.showInformationMessage(`Deployment updated.`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Edit failed: ${err.message}`);
      }
    }),

    // ── Remove Deployment (single deployment from tree) ──
    vscode.commands.registerCommand('tomCattery.removeDeployment', async (item?: DeploymentTreeItem) => {
      if (!(item instanceof DeploymentTreeItem)) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove deployment "${item.deployment.name}" (${item.deployment.contextPath}) from "${item.instance.name}"?`,
        { modal: true },
        'Remove',
      );
      if (confirm !== 'Remove') {
        return;
      }
      try {
        await deployManager.cleanDeployment(item.instance, item.deployment);
        await instanceManager.removeDeployment(item.instance.name, item.deployment.contextPath);
        treeProvider.setServers(instanceManager.getInstances());
        vscode.window.showInformationMessage(`Deployment "${item.deployment.name}" removed.`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Remove failed: ${err.message}`);
      }
    }),

    // ── Toggle Auto Deploy ──
    vscode.commands.registerCommand('tomCattery.toggleAutoDeploy', async (item?: DeploymentTreeItem) => {
      if (!(item instanceof DeploymentTreeItem)) {
        return;
      }
      const dep = item.deployment;
      const instance = item.instance;

      dep.autoDeploy = !dep.autoDeploy;
      await instanceManager.addDeployment(instance.name, dep);
      treeProvider.setServers(instanceManager.getInstances());

      console.log(`[Tom Cattery] toggleAutoDeploy: ${dep.name} → autoDeploy=${dep.autoDeploy}, server status=${instance.status}`);

      // Set up or refresh watchers if server is running
      if (instance.status === 'running' || instance.status === 'debugging') {
        const updatedInstance = instanceManager.getInstances().find(i => i.name === instance.name);
        console.log(`[Tom Cattery] updatedInstance found: ${!!updatedInstance}`);
        if (updatedInstance) {
          deployManager.setupWatchers(updatedInstance);
        }
      } else {
        console.log(`[Tom Cattery] Server not running (${instance.status}), watchers will activate on server start`);
      }

      vscode.window.showInformationMessage(
        dep.autoDeploy
          ? `Auto-deploy enabled for "${dep.name}" (${dep.contextPath}).`
          : `Auto-deploy disabled for "${dep.name}" (${dep.contextPath}).`,
      );
    }),

    // ── Edit Configuration ──
    vscode.commands.registerCommand('tomCattery.openConfig', async (item?: ServerTreeItem) => {
      const instance = item?.instance ?? await pickServer(instanceManager);
      if (!instance) {
        return;
      }
      configWebviewProvider.openConfig(instance);
    }),

    // ── Open Logs ──
    vscode.commands.registerCommand('tomCattery.openLogs', async (item?: ServerTreeItem) => {
      const instance = item?.instance ?? await pickServer(instanceManager);
      if (!instance) {
        return;
      }
      logStreamer.show(instance.name);
    }),

    // ── Delete Server ──
    vscode.commands.registerCommand('tomCattery.deleteServer', async (item?: ServerTreeItem) => {
      let serverName: string;

      if (item) {
        serverName = item.instance.name;
      } else {
        const server = await pickServer(instanceManager);
        if (!server) {
          return;
        }
        serverName = server.name;
      }

      if (processManager.isRunning(serverName)) {
        vscode.window.showWarningMessage(`Stop server "${serverName}" before deleting.`);
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Delete server "${serverName}"? This removes all server files permanently.`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        try {
          await instanceManager.deleteInstance(serverName);
          logStreamer.disposeChannel(serverName);
          treeProvider.setServers(instanceManager.getInstances());
          vscode.window.showInformationMessage(`Server "${serverName}" deleted.`);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to delete server: ${err.message}`);
        }
      }
    }),
  );
}
