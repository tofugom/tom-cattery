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
import { PortUtils } from '../core/PortUtils';

interface JavaRuntime {
  name: string;
  path: string;
  default?: boolean;
}

/**
 * java.configuration.runtimes에서 등록된 JDK 목록을 읽어온다.
 */
function getJavaRuntimes(): JavaRuntime[] {
  const javaConfig = vscode.workspace.getConfiguration('java');
  return javaConfig.get<JavaRuntime[]>('configuration.runtimes', []);
}

interface JavaHomeSelection {
  path: string;
  name?: string;
}

/**
 * JDK 선택 QuickPick을 표시한다.
 * 1) java.configuration.runtimes에 등록된 JDK가 있으면 → 명칭 기반 목록에서 선택 (default JDK가 맨 위)
 * 2) 등록된 JDK가 없으면 → 설정 안내 + 직접 선택 제공
 */
async function selectJavaHome(): Promise<JavaHomeSelection | undefined> {
  const runtimes = getJavaRuntimes();

  if (runtimes.length > 0) {
    // JDK가 등록되어 있음 → 명칭 기반 선택
    const sorted = [...runtimes].sort((a, b) => {
      if (a.default && !b.default) { return -1; }
      if (!a.default && b.default) { return 1; }
      return 0;
    });

    const items = [
      ...sorted.map(r => ({
        label: r.name,
        description: r.default ? '(기본값)' : '',
        runtimeName: r.name,
        value: r.path,
      })),
      { label: '$(folder-opened) 로컬 JDK 직접 선택...', description: '', runtimeName: '', value: '__browse__' },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'JAVA_HOME 선택',
    });
    if (!picked) { return undefined; }

    if (picked.value !== '__browse__') {
      return { path: picked.value, name: picked.runtimeName };
    }
    // '__browse__' → 아래 파일 브라우저로 이동
  } else {
    // JDK가 등록되어 있지 않음 → 안내 + 선택지
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(folder-opened) 로컬 JDK 직접 선택', description: '설치된 JDK 폴더를 선택합니다', value: 'browse' as const },
        { label: '$(gear) java.configuration.runtimes 설정 열기', description: 'settings.json에서 JDK를 등록합니다', value: 'settings' as const },
      ],
      { placeHolder: 'java.configuration.runtimes에 등록된 JDK가 없습니다' },
    );
    if (!choice) { return undefined; }

    if (choice.value === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'java.configuration.runtimes');
      return undefined;
    }
    // 'browse' → 아래 파일 브라우저로 이동
  }

  // 파일 브라우저
  const javaUri = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'JAVA_HOME 디렉토리 선택',
  });
  if (javaUri && javaUri.length > 0) {
    return { path: javaUri[0].fsPath };
  }
  return undefined;
}

async function pickServer(
  instanceManager: InstanceManager,
  filter?: (i: TomcatInstance) => boolean,
): Promise<TomcatInstance | undefined> {
  let servers = instanceManager.getInstances();
  if (filter) {
    servers = servers.filter(filter);
  }
  if (servers.length === 0) {
    const action = await vscode.window.showInformationMessage(
      '등록된 서버가 없습니다.',
      '서버 추가',
    );
    if (action === '서버 추가') {
      vscode.commands.executeCommand('tomCattery.addServer');
    }
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
            'Tomcat Runtime이 등록되어 있지 않습니다.',
            '다운로드',
            '로컬 선택',
          );
          if (action === '다운로드') {
            selectedRuntime = await runtimeManager.downloadRuntime();
          } else if (action === '로컬 선택') {
            selectedRuntime = await runtimeManager.addLocalRuntime();
          } else {
            return;
          }
        } else {
          const items = [
            ...runtimes.map(r => ({
              label: `Apache Tomcat ${r.version}`,
              description: r.type === 'downloaded' ? '(다운로드됨)' : r.path,
              runtime: r,
              id: 'runtime' as const,
            })),
            { label: '$(cloud-download) Tomcat 다운로드...', description: '', runtime: undefined as any, id: 'download' as const },
            { label: '$(folder-opened) 로컬 Runtime 추가...', description: '', runtime: undefined as any, id: 'local' as const },
          ];
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Tomcat Runtime을 선택하세요',
          });
          if (!picked) {
            return;
          }
          if (picked.id === 'download') {
            selectedRuntime = await runtimeManager.downloadRuntime();
          } else if (picked.id === 'local') {
            selectedRuntime = await runtimeManager.addLocalRuntime();
          } else {
            selectedRuntime = picked.runtime;
          }
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
        const defaultPort = vscode.workspace.getConfiguration('tomCattery').get<number>('defaultHttpPort', 8080);
        const httpPortStr = await vscode.window.showInputBox({
          prompt: 'HTTP 포트 (나머지 포트는 자동 계산됩니다)',
          value: String(defaultPort),
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
        const ports: PortConfig = PortUtils.derivePorts(httpPort);

        // 3-1. 포트 충돌 감지
        const existingInstances = instanceManager.getInstances();
        const conflict = PortUtils.findConflict(ports, existingInstances);
        const httpInUse = await PortUtils.isPortInUse(ports.http);

        if (conflict || httpInUse) {
          const reason = conflict || `HTTP 포트 ${ports.http}이(가) 이미 시스템에서 사용 중입니다.`;
          const choice = await vscode.window.showQuickPick(
            [
              { label: '$(wand) 자동 할당', description: '사용 가능한 포트를 자동으로 찾습니다', value: 'auto' as const },
              { label: '$(edit) 직접 입력', description: '다른 포트를 직접 입력합니다', value: 'manual' as const },
            ],
            { placeHolder: `⚠ ${reason}` },
          );

          if (!choice) { return; }

          if (choice.value === 'auto') {
            const available = await PortUtils.findAvailablePorts(ports.http + 1, existingInstances);
            Object.assign(ports, available);
            vscode.window.showInformationMessage(`자동 할당된 HTTP 포트: ${ports.http}`);
          } else {
            const newPortStr = await vscode.window.showInputBox({
              prompt: `HTTP 포트 (${ports.http}은 사용 불가)`,
              validateInput: (v) => {
                const n = parseInt(v);
                if (isNaN(n) || n < 1 || n > 65535) {
                  return '포트는 1~65535 사이여야 합니다';
                }
                return undefined;
              },
            });
            if (!newPortStr) { return; }
            Object.assign(ports, PortUtils.derivePorts(parseInt(newPortStr)));
          }
        }

        // 4. JAVA_HOME (java.configuration.runtimes → 직접 선택)
        const javaSelection = await selectJavaHome();
        if (!javaSelection) {
          return;
        }

        // 5. Create instance
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Creating server "${name}"...` },
          async () => {
            await instanceManager.createInstance(name, selectedRuntime, ports, javaSelection.path, javaSelection.name);
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

    // ── Download Runtime ──
    vscode.commands.registerCommand('tomCattery.downloadRuntime', async () => {
      await runtimeManager.downloadRuntime();
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
        const action = await vscode.window.showErrorMessage(
          `서버 시작 실패: ${err.message}`,
          '로그 보기',
        );
        if (action === '로그 보기') {
          logStreamer.show(instance.name);
        }
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
        const action = await vscode.window.showErrorMessage(
          `서버 중지 실패: ${err.message}`,
          '로그 보기',
        );
        if (action === '로그 보기') {
          logStreamer.show(instance.name);
        }
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
        const action = await vscode.window.showErrorMessage(
          `서버 재시작 실패: ${err.message}`,
          '로그 보기',
        );
        if (action === '로그 보기') {
          logStreamer.show(instance.name);
        }
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
          { location: vscode.ProgressLocation.Notification, title: `"${instance.name}" 디버그 시작 중...`, cancellable: false },
          () => debugController.debugServer(instance),
        );
      } catch (err: any) {
        const action = await vscode.window.showErrorMessage(
          `디버그 실패: ${err.message}`,
          '로그 보기',
        );
        if (action === '로그 보기') {
          logStreamer.show(instance.name);
        }
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
