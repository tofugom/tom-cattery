import * as vscode from 'vscode';
import { TomcatInstance } from './types';
import { ServerTreeProvider } from './views/ServerTreeProvider';
import { ConfigWebviewProvider } from './views/ConfigWebviewProvider';
import { RuntimeManager } from './core/RuntimeManager';
import { InstanceManager } from './core/InstanceManager';
import { ProcessManager } from './core/ProcessManager';
import { LogStreamer } from './core/LogStreamer';
import { DeployManager } from './core/DeployManager';
import { DebugController } from './core/DebugController';
import { registerServerCommands } from './commands/serverCommands';

let processManager: ProcessManager | undefined;
let logStreamer: LogStreamer | undefined;
let debugController: DebugController | undefined;
let deployManager: DeployManager | undefined;
let configWebviewProvider: ConfigWebviewProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Tom Cattery is now active!');

  const runtimeManager = new RuntimeManager(context);
  const instanceManager = new InstanceManager();
  const serverTreeProvider = new ServerTreeProvider();

  const treeView = vscode.window.createTreeView('tomCattery.servers', {
    treeDataProvider: serverTreeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Load existing servers from disk
  const servers = await instanceManager.loadInstances();
  serverTreeProvider.setServers(servers);

  logStreamer = new LogStreamer();
  deployManager = new DeployManager();
  deployManager.setLogStreamer(logStreamer);

  // Status change callback: update instance status + refresh TreeView + manage watchers
  const onStatusChange = (name: string, status: TomcatInstance['status'], pid?: number) => {
    console.log(`[Tom Cattery] onStatusChange: "${name}" → ${status} (pid: ${pid})`);
    instanceManager.updateStatus(name, status, pid);
    serverTreeProvider.setServers(instanceManager.getInstances());

    // Auto-deploy watcher lifecycle
    if (status === 'running' || status === 'debugging') {
      const inst = instanceManager.getInstances().find(i => i.name === name);
      if (inst) {
        const autoCount = inst.deployments.filter(d => d.autoDeploy).length;
        console.log(`[Tom Cattery] Server "${name}" is ${status}. Setting up watchers (${autoCount} auto-deploy deployment(s))`);
        deployManager!.setupWatchers(inst);
      }
    } else if (status === 'stopped') {
      deployManager!.disposeWatchers(name);
    }
  };

  processManager = new ProcessManager(logStreamer, onStatusChange);
  debugController = new DebugController(processManager, instanceManager, logStreamer, onStatusChange);
  configWebviewProvider = new ConfigWebviewProvider(instanceManager, processManager, serverTreeProvider);

  registerServerCommands(
    context,
    serverTreeProvider,
    runtimeManager,
    instanceManager,
    processManager,
    logStreamer,
    deployManager,
    debugController,
    configWebviewProvider,
  );
}

export function deactivate() {
  configWebviewProvider?.dispose();
  deployManager?.disposeAllWatchers();
  debugController?.disposeAll();
  processManager?.killAll();
  logStreamer?.disposeAll();
  console.log('Tom Cattery deactivated');
}
