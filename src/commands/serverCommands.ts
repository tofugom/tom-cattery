import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TomcatInstance, PortConfig, Deployment, TomcatRuntime, TomCatteryExportData, TomCatteryServerExport } from '../types';
import { ServerTreeProvider, ServerTreeItem, DeploymentTreeItem } from '../views/ServerTreeProvider';
import { ConfigWebviewProvider } from '../views/ConfigWebviewProvider';
import { RuntimeManager } from '../core/RuntimeManager';
import { InstanceManager } from '../core/InstanceManager';
import { ProcessManager } from '../core/ProcessManager';
import { LogStreamer } from '../core/LogStreamer';
import { DeployManager } from '../core/DeployManager';
import { DebugController } from '../core/DebugController';
import { PortUtils } from '../core/PortUtils';
import { GradleProjectScanner, GradleWarModule } from '../core/GradleProjectScanner';

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
  pendingBrowserOpen: Set<string>,
): void {
  // Gradle deployment 가 등록된 서버는 start/restart/debug 시
  // 자동으로 gradle build → WAR explode 를 먼저 수행한다.
  // 등록된 deployment 중 type === 'gradle' 만 대상이며,
  // 이미 빌드된 WAR 를 직접 등록한 type === 'war' 는 건드리지 않는다.
  async function buildAndDeployGradle(instance: TomcatInstance): Promise<void> {
    const gradleDeployments = instance.deployments.filter(
      d => d.type === 'gradle' && d.buildTask,
    );
    for (const dep of gradleDeployments) {
      await deployManager.deploy(instance, dep);
    }
  }

  context.subscriptions.push(
    // ── Add Server ──
    vscode.commands.registerCommand('tomCattery.addServer', async () => {
      try {
        // 서버는 워크스페이스별로 관리된다 — 워크스페이스가 없으면 생성 불가
        if (!instanceManager.registryPath) {
          vscode.window.showWarningMessage(
            'Tom Cattery 서버는 워크스페이스별로 관리됩니다. 먼저 폴더나 워크스페이스를 여세요.',
          );
          return;
        }

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
        pendingBrowserOpen.add(instance.name);
        await instanceManager.ensureBase(instance);
        await buildAndDeployGradle(instance);
        await processManager.startServer(instance);
      } catch (err: any) {
        pendingBrowserOpen.delete(instance.name);
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
        pendingBrowserOpen.add(instance.name);
        await processManager.stopServer(instance);
        await buildAndDeployGradle(instance);
        await processManager.startServer(instance);
      } catch (err: any) {
        pendingBrowserOpen.delete(instance.name);
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
        pendingBrowserOpen.add(instance.name);
        await instanceManager.ensureBase(instance);
        await buildAndDeployGradle(instance);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `"${instance.name}" 디버그 시작 중...`, cancellable: false },
          () => debugController.debugServer(instance),
        );
      } catch (err: any) {
        pendingBrowserOpen.delete(instance.name);
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

      // 배포 추가 방식 선택
      const method = await vscode.window.showQuickPick([
        { label: '$(search) Gradle 모듈 자동 감지', description: 'settings.gradle에서 WAR 모듈을 스캔합니다', id: 'gradle' },
        { label: '$(file) WAR 파일 직접 선택', description: '빌드된 WAR 파일을 직접 선택합니다', id: 'manual' },
      ], { placeHolder: '배포 추가 방식을 선택하세요' });

      if (!method) { return; }

      if (method.id === 'gradle') {
        try {
          await addGradleDeploymentsToServer(instance);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Gradle 배포 등록 실패: ${err.message}`);
        }
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

      const choice = await vscode.window.showQuickPick([
        { label: '$(terminal) 콘솔 출력 (stdout)', id: 'stdout' },
        { label: '$(file) 로그 파일 열기...', id: 'file' },
      ], { placeHolder: '로그 유형을 선택하세요' });

      if (!choice) {
        return;
      }

      if (choice.id === 'stdout') {
        logStreamer.show(instance.name);
        return;
      }

      // 로그 파일 선택
      const logsDir = path.join(instance.basePath, 'logs');
      try {
        const entries = await fs.readdir(logsDir, { withFileTypes: true });
        const logFiles: { name: string; size: number; mtime: Date }[] = [];

        for (const entry of entries) {
          if (!entry.isDirectory()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (['.log', '.out', '.txt'].includes(ext)) {
              const stat = await fs.stat(path.join(logsDir, entry.name));
              logFiles.push({ name: entry.name, size: stat.size, mtime: stat.mtime });
            }
          }
        }

        if (logFiles.length === 0) {
          vscode.window.showInformationMessage(`"${instance.name}" 서버의 로그 파일이 없습니다.`);
          return;
        }

        // 최신 파일 순으로 정렬
        logFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        const formatSize = (bytes: number): string => {
          if (bytes < 1024) { return `${bytes} B`; }
          if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
          return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        };

        const picked = await vscode.window.showQuickPick(
          logFiles.map(f => ({
            label: f.name,
            description: `${formatSize(f.size)} · ${f.mtime.toLocaleString()}`,
            filePath: path.join(logsDir, f.name),
          })),
          { placeHolder: '열 로그 파일을 선택하세요' },
        );

        if (picked) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.filePath));
          await vscode.window.showTextDocument(doc, { preview: false });
        }
      } catch {
        vscode.window.showWarningMessage(`로그 디렉터리에 접근할 수 없습니다: ${logsDir}`);
      }
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

    // ── Reset Global Storage ──
    vscode.commands.registerCommand('tomCattery.resetGlobalStorage', async () => {
      // 1. 1차 확인
      const confirm1 = await vscode.window.showWarningMessage(
        '모든 Tom Cattery 데이터(서버, 런타임, 설정)가 삭제됩니다. 이 작업은 되돌릴 수 없습니다.',
        { modal: true },
        '계속',
      );
      if (confirm1 !== '계속') { return; }

      // 2. 2차 확인: "RESET" 타이핑
      const typed = await vscode.window.showInputBox({
        prompt: '초기화를 진행하려면 "RESET"을 입력하세요',
        placeHolder: 'RESET',
        validateInput: (v) => v === 'RESET' ? undefined : '"RESET"을 정확히 입력해주세요',
      });
      if (typed !== 'RESET') { return; }

      // 3. 실행 중인 서버 중지
      const runningServers = instanceManager.getInstances().filter(
        i => processManager.isRunning(i.name),
      );
      if (runningServers.length > 0) {
        const stopConfirm = await vscode.window.showWarningMessage(
          `${runningServers.length}개의 서버가 실행 중입니다. 모두 중지 후 초기화합니다.`,
          { modal: true },
          '중지 후 초기화',
        );
        if (stopConfirm !== '중지 후 초기화') { return; }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: '서버 중지 중...' },
          async () => {
            for (const server of runningServers) {
              try { await processManager.stopServer(server); } catch { /* ignore */ }
            }
            processManager.killAll();
          },
        );
      }

      // 4. 리소스 정리
      deployManager.disposeAllWatchers();
      debugController.disposeAll();
      logStreamer.disposeAll();
      configWebviewProvider.dispose();

      // 5. 데이터 삭제
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Tom Cattery 데이터 초기화 중...' },
        async () => {
          const globalStoragePath = context.globalStorageUri.fsPath;
          await fs.rm(globalStoragePath, { recursive: true, force: true });
          await context.globalState.update('tomcatRuntimes', undefined);
          // 워크스페이스 레지스트리도 함께 제거 (완전 초기화)
          if (instanceManager.registryPath) {
            await fs.rm(instanceManager.registryPath, { force: true });
          }
        },
      );

      // 6. 인메모리 상태 초기화
      runtimeManager.clearRuntimes();
      await instanceManager.loadInstances();
      treeProvider.setServers(instanceManager.getInstances());

      vscode.window.showInformationMessage('Tom Cattery 데이터가 초기화되었습니다. 모든 서버와 런타임이 삭제되었습니다.');
    }),

    // ── Export Config ──
    vscode.commands.registerCommand('tomCattery.exportConfig', async (item?: ServerTreeItem) => {
      const instances = instanceManager.getInstances();
      if (instances.length === 0) {
        vscode.window.showInformationMessage('내보낼 서버가 없습니다.');
        return;
      }

      // Export 대상 결정
      let serversToExport: TomcatInstance[];

      if (item?.instance) {
        serversToExport = [item.instance];
      } else {
        const choices = [
          { label: '$(server-environment) 전체 서버 내보내기', description: `${instances.length}개 서버`, value: '__all__' },
          ...instances.map(i => ({
            label: i.name,
            description: `:${i.ports.http} (${i.status})`,
            value: i.name,
          })),
        ];
        const picked = await vscode.window.showQuickPick(choices, {
          placeHolder: '내보낼 서버를 선택하세요',
        });
        if (!picked) { return; }

        if (picked.value === '__all__') {
          serversToExport = instances;
        } else {
          const found = instances.find(i => i.name === picked.value);
          if (!found) { return; }
          serversToExport = [found];
        }
      }

      // Export 데이터 구성
      const runtimes = runtimeManager.getRuntimes();
      const exportData: TomCatteryExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        servers: serversToExport.map(inst => {
          const rt = runtimes.find(r => r.path === inst.runtimePath);
          return {
            name: inst.name,
            runtimePath: inst.runtimePath,
            runtimeVersion: rt?.version,
            runtimeType: rt?.type,
            javaHome: inst.javaHome,
            javaHomeName: inst.javaHomeName,
            ports: { ...inst.ports },
            jvmArgs: [...inst.jvmArgs],
            envVars: { ...inst.envVars },
            deployments: inst.deployments.map(d => ({ ...d })),
            debug: { ...inst.debug },
            timeouts: { ...inst.timeouts },
          };
        }),
      };

      const defaultName = serversToExport.length === 1
        ? `tom-cattery-${serversToExport[0].name}.json`
        : 'tom-cattery-export.json';

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
            defaultName,
          ),
        ),
        filters: { 'JSON files': ['json'] },
        title: '서버 설정 내보내기',
      });
      if (!uri) { return; }

      await fs.writeFile(uri.fsPath, JSON.stringify(exportData, null, 2), 'utf-8');
      vscode.window.showInformationMessage(
        `${serversToExport.length}개 서버 설정을 ${path.basename(uri.fsPath)}에 내보냈습니다.`,
      );
    }),

    // ── Import Config ──
    vscode.commands.registerCommand('tomCattery.importConfig', async (filePath?: string) => {
      // 1. 파일 경로 결정 (인자로 받거나 사용자 선택)
      let targetPath: string;
      if (filePath) {
        targetPath = filePath;
      } else {
        const fileUris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'JSON files': ['json'] },
          openLabel: '설정 파일 선택',
        });
        if (!fileUris || fileUris.length === 0) { return; }
        targetPath = fileUris[0].fsPath;
      }

      // 2. 파일 파싱
      let exportData: TomCatteryExportData;
      try {
        const content = await fs.readFile(targetPath, 'utf-8');
        exportData = JSON.parse(content);
      } catch (err: any) {
        vscode.window.showErrorMessage(`설정 파일을 읽을 수 없습니다: ${err.message}`);
        return;
      }

      // 3. 포맷 검증
      if (!exportData.version || !Array.isArray(exportData.servers) || exportData.servers.length === 0) {
        vscode.window.showErrorMessage('유효하지 않은 Tom Cattery 설정 파일입니다.');
        return;
      }

      // 4. Import할 서버 선택
      const serverItems = exportData.servers.map(s => ({
        label: s.name,
        description: `HTTP:${s.ports.http} | Runtime: ${s.runtimeVersion || 'unknown'}`,
        picked: true,
        serverData: s,
      }));

      const pickedServers = await vscode.window.showQuickPick(serverItems, {
        placeHolder: `가져올 서버를 선택하세요 (${exportData.servers.length}개 포함)`,
        canPickMany: true,
      });
      if (!pickedServers || pickedServers.length === 0) { return; }

      // 5. Import 실행
      let imported = 0;
      let skipped = 0;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '서버 설정 가져오는 중...' },
        async (progress) => {
          for (const item of pickedServers) {
            progress.report({ message: `${item.serverData.name} (${imported + skipped + 1}/${pickedServers.length})` });
            try {
              await importSingleServer(item.serverData);
              imported++;
            } catch (err: any) {
              if (err.message !== 'Skipped by user') {
                vscode.window.showWarningMessage(`"${item.serverData.name}" 가져오기 실패: ${err.message}`);
              }
              skipped++;
            }
          }
        },
      );

      treeProvider.setServers(instanceManager.getInstances());
      if (imported > 0) {
        vscode.window.showInformationMessage(
          `${imported}개 서버를 가져왔습니다.` + (skipped > 0 ? ` (${skipped}개 스킵)` : ''),
        );
      }
    }),

    // ── Save to Workspace ──
    // 서버 정의는 항상 .vscode/tom-cattery.json 레지스트리에 자동 동기화되므로,
    // 이 명령은 레지스트리를 강제로 다시 기록하는 용도(복구/수동 저장)로만 남긴다.
    vscode.commands.registerCommand('tomCattery.saveToWorkspace', async () => {
      if (!instanceManager.registryPath) {
        vscode.window.showWarningMessage('워크스페이스가 열려 있지 않습니다.');
        return;
      }
      const count = instanceManager.getInstances().length;
      await instanceManager.saveRegistry();
      vscode.window.showInformationMessage(
        `${count}개 서버 설정을 .vscode/tom-cattery.json에 저장했습니다.`,
      );
    }),

    // ── Clone Server ──
    vscode.commands.registerCommand('tomCattery.cloneServer', async (item?: ServerTreeItem) => {
      const source = item?.instance ?? await pickServer(instanceManager);
      if (!source) {
        return;
      }

      const newName = await vscode.window.showInputBox({
        prompt: `서버 "${source.name}"을 복제합니다. 새 서버 이름을 입력하세요.`,
        placeHolder: `${source.name}-copy`,
        validateInput: (value) => {
          if (!value || !value.trim()) {
            return '서버 이름을 입력하세요.';
          }
          if (instanceManager.getInstance(value.trim())) {
            return `"${value.trim()}" 이름의 서버가 이미 존재합니다.`;
          }
          if (/[\/\\:*?"<>|]/.test(value)) {
            return '서버 이름에 특수 문자를 사용할 수 없습니다.';
          }
          return undefined;
        },
      });
      if (!newName) {
        return;
      }

      try {
        const newPorts = await PortUtils.findAvailablePorts(
          source.ports.http + 1,
          instanceManager.getInstances(),
        );

        const instance = await instanceManager.cloneInstance(source.name, newName.trim(), newPorts);
        treeProvider.setServers(instanceManager.getInstances());
        vscode.window.showInformationMessage(
          `서버 "${source.name}"이 "${newName.trim()}"(으)로 복제되었습니다. (HTTP: ${newPorts.http})`,
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`서버 복제 실패: ${err.message}`);
      }
    }),

    // ── Add Gradle Deployments ──
    vscode.commands.registerCommand('tomCattery.addGradleDeployments', async (item?: ServerTreeItem) => {
      const instance = item?.instance ?? await pickServer(instanceManager);
      if (!instance) {
        return;
      }
      try {
        await addGradleDeploymentsToServer(instance);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Gradle 배포 등록 실패: ${err.message}`);
      }
    }),
  );

  // ── Gradle 배포 등록 헬퍼 ──
  async function addGradleDeploymentsToServer(instance: TomcatInstance): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showWarningMessage('워크스페이스가 열려 있지 않습니다.');
      return;
    }

    const scanner = new GradleProjectScanner();
    const modules = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Gradle WAR 모듈 스캔 중...' },
      () => scanner.scanWorkspace(workspaceRoot),
    );

    if (modules.length === 0) {
      vscode.window.showWarningMessage('WAR 모듈을 찾을 수 없습니다. build.gradle에 war 플러그인이 있는지 확인하세요.');
      return;
    }

    // 이미 등록된 배포의 buildTask 목록
    const existingTasks = new Set(instance.deployments.map(d => d.buildTask).filter(Boolean));

    const items = modules.map(m => ({
      label: m.name,
      description: existingTasks.has(m.buildTask)
        ? `${m.buildTask} → /${m.name}  (이미 등록됨)`
        : `${m.buildTask} → /${m.name}`,
      picked: false,
      module: m,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `등록할 WAR 모듈을 체크하세요 (${modules.length}개 감지됨)`,
      canPickMany: true,
    });

    if (!picked || picked.length === 0) {
      return;
    }

    let added = 0;
    for (const item of picked) {
      const m = item.module;
      const deploymentName = m.name;
      const contextPath = `/${m.name}`;

      // 같은 contextPath가 이미 있으면 스킵
      if (instance.deployments.some(d => d.contextPath === contextPath)) {
        continue;
      }

      const deployment: Deployment = {
        name: deploymentName,
        type: 'gradle',
        buildTask: m.buildTask,
        warPath: m.warPath,
        contextPath,
        autoDeploy: false,
        watchPaths: [m.watchPath],
      };

      await instanceManager.addDeployment(instance.name, deployment);
      added++;
    }

    // 인스턴스 새로고침
    treeProvider.setServers(instanceManager.getInstances());

    if (added > 0) {
      vscode.window.showInformationMessage(`${added}개 Gradle 배포가 "${instance.name}"에 등록되었습니다.`);
    } else {
      vscode.window.showInformationMessage('선택한 모듈이 이미 모두 등록되어 있습니다.');
    }
  }

  // ── Import 헬퍼 ──
  async function importSingleServer(serverExport: TomCatteryServerExport): Promise<void> {
    // 이름 충돌 확인
    const existing = instanceManager.getInstance(serverExport.name);
    if (existing) {
      const action = await vscode.window.showWarningMessage(
        `서버 "${serverExport.name}"이(가) 이미 존재합니다. 덮어쓸까요?`,
        { modal: true },
        '덮어쓰기',
        '건너뛰기',
      );
      if (action !== '덮어쓰기') {
        throw new Error('Skipped by user');
      }
      if (processManager.isRunning(serverExport.name)) {
        await processManager.stopServer(existing);
      }
      logStreamer.disposeChannel(serverExport.name);
      deployManager.disposeWatchers(serverExport.name);
      await instanceManager.deleteInstance(serverExport.name);
    }

    // runtimePath 유효성 확인
    let runtimePath = serverExport.runtimePath;
    const runtimeValid = await runtimeManager.validateRuntime(runtimePath);

    if (!runtimeValid.valid) {
      const action = await vscode.window.showWarningMessage(
        `"${serverExport.name}"의 Runtime 경로가 유효하지 않습니다: ${runtimePath}`,
        'Runtime 선택',
        '건너뛰기',
      );
      if (action !== 'Runtime 선택') {
        throw new Error('Runtime not available');
      }

      const runtimes = runtimeManager.getRuntimes();
      if (runtimes.length > 0) {
        const items = [
          ...runtimes.map(r => ({
            label: `Apache Tomcat ${r.version}`,
            description: r.type === 'downloaded' ? '(다운로드됨)' : r.path,
            runtime: r,
            id: 'existing' as const,
          })),
          { label: '$(folder-opened) 로컬 Runtime 선택...', description: '', runtime: undefined as any, id: 'browse' as const },
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Tomcat Runtime을 선택하세요',
        });
        if (!picked) { throw new Error('Runtime not selected'); }

        if (picked.id === 'browse') {
          const addedRuntime = await runtimeManager.addLocalRuntime();
          if (!addedRuntime) { throw new Error('Runtime not selected'); }
          runtimePath = addedRuntime.path;
        } else {
          runtimePath = picked.runtime.path;
        }
      } else {
        const addedRuntime = await runtimeManager.addLocalRuntime();
        if (!addedRuntime) { throw new Error('Runtime not selected'); }
        runtimePath = addedRuntime.path;
      }
    }

    // javaHome 유효성 확인
    let javaHome = serverExport.javaHome;
    let javaHomeName = serverExport.javaHomeName;

    try {
      await fs.access(javaHome);
    } catch {
      const action = await vscode.window.showWarningMessage(
        `"${serverExport.name}"의 JAVA_HOME이 유효하지 않습니다: ${javaHome}`,
        'JAVA_HOME 선택',
        '건너뛰기',
      );
      if (action !== 'JAVA_HOME 선택') {
        throw new Error('JAVA_HOME not available');
      }

      const javaSelection = await selectJavaHome();
      if (!javaSelection) { throw new Error('JAVA_HOME not selected'); }
      javaHome = javaSelection.path;
      javaHomeName = javaSelection.name;
    }

    // 서버 생성 (createInstance: 디렉터리 생성, conf 복사, server.xml 패치, setenv 생성)
    const runtimeForCreate: TomcatRuntime = {
      version: serverExport.runtimeVersion || 'unknown',
      path: runtimePath,
      type: serverExport.runtimeType || 'local',
      majorVersion: parseInt((serverExport.runtimeVersion || '0').split('.')[0]) || 0,
    };

    const instance = await instanceManager.createInstance(
      serverExport.name,
      runtimeForCreate,
      serverExport.ports,
      javaHome,
      javaHomeName,
    );

    // 추가 설정 적용 (createInstance가 설정하지 않는 항목들)
    instance.jvmArgs = serverExport.jvmArgs || [];
    instance.envVars = serverExport.envVars || {};
    instance.deployments = serverExport.deployments || [];
    instance.debug = serverExport.debug || instance.debug;
    instance.timeouts = serverExport.timeouts || instance.timeouts;

    // 전체 설정 저장 (.tom-cattery.json + server.xml + setenv 반영)
    await instanceManager.saveFullConfig(instance);
  }
}
