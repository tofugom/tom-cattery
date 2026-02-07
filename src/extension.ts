import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { TomcatInstance, TomcatRuntime, TomCatteryExportData } from './types';
import { ServerTreeProvider } from './views/ServerTreeProvider';
import { ConfigWebviewProvider } from './views/ConfigWebviewProvider';
import { RuntimeManager } from './core/RuntimeManager';
import { InstanceManager } from './core/InstanceManager';
import { ProcessManager } from './core/ProcessManager';
import { LogStreamer } from './core/LogStreamer';
import { DeployManager } from './core/DeployManager';
import { DebugController } from './core/DebugController';
import { registerServerCommands } from './commands/serverCommands';
import { MetricsCollector } from './core/MetricsCollector';

let processManager: ProcessManager | undefined;
let logStreamer: LogStreamer | undefined;
let debugController: DebugController | undefined;
let deployManager: DeployManager | undefined;
let configWebviewProvider: ConfigWebviewProvider | undefined;

/** 사용자가 직접 Start/Debug/Restart 한 서버만 브라우저를 연다 (extension 재로드 시 방지) */
const pendingBrowserOpen = new Set<string>();
let metricsTimer: ReturnType<typeof setInterval> | undefined;

/**
 * ~/.vscode/tom-cattery/ → globalStorageUri 마이그레이션
 * - servers/ → {globalStorageUri}/servers/
 * - runtimes/ → {globalStorageUri}/tomcat/
 * - globalState runtimes 경로 업데이트
 * - .tom-cattery.json runtimePath 업데이트
 */
async function migrateFromLegacyPath(context: vscode.ExtensionContext): Promise<void> {
  const legacyBase = path.join(os.homedir(), '.vscode', 'tom-cattery');
  const newBase = context.globalStorageUri.fsPath;

  try {
    await fs.access(legacyBase);
  } catch {
    return; // 기존 경로 없으면 마이그레이션 불필요
  }

  console.log(`[Tom Cattery] 마이그레이션 시작: ${legacyBase} → ${newBase}`);

  // globalStorageUri 디렉터리 보장
  await fs.mkdir(newBase, { recursive: true });

  const legacyServers = path.join(legacyBase, 'servers');
  const legacyRuntimes = path.join(legacyBase, 'runtimes');
  const newServers = path.join(newBase, 'servers');
  const newTomcat = path.join(newBase, 'tomcat');

  // 1. servers 이동
  try {
    await fs.access(legacyServers);
    await fs.mkdir(newServers, { recursive: true });
    const serverEntries = await fs.readdir(legacyServers, { withFileTypes: true });
    for (const entry of serverEntries) {
      if (!entry.isDirectory()) { continue; }
      const src = path.join(legacyServers, entry.name);
      const dst = path.join(newServers, entry.name);
      try {
        await fs.access(dst);
        console.log(`[Tom Cattery] 서버 "${entry.name}" 이미 존재, 스킵`);
      } catch {
        await fs.rename(src, dst);
        console.log(`[Tom Cattery] 서버 이동: ${entry.name}`);
      }
    }
  } catch {
    // servers 디렉터리 없음
  }

  // 2. runtimes → tomcat 이동
  try {
    await fs.access(legacyRuntimes);
    await fs.mkdir(newTomcat, { recursive: true });
    const runtimeEntries = await fs.readdir(legacyRuntimes, { withFileTypes: true });
    for (const entry of runtimeEntries) {
      if (!entry.isDirectory()) { continue; }
      const src = path.join(legacyRuntimes, entry.name);
      const dst = path.join(newTomcat, entry.name);
      try {
        await fs.access(dst);
        console.log(`[Tom Cattery] 런타임 "${entry.name}" 이미 존재, 스킵`);
      } catch {
        await fs.rename(src, dst);
        console.log(`[Tom Cattery] 런타임 이동: ${entry.name}`);
      }
    }
  } catch {
    // runtimes 디렉터리 없음
  }

  // 3. globalState의 tomcatRuntimes 경로 업데이트
  const runtimes = context.globalState.get<TomcatRuntime[]>('tomcatRuntimes', []);
  let runtimesUpdated = false;
  for (const rt of runtimes) {
    if (rt.path.startsWith(legacyRuntimes)) {
      const relativePart = path.relative(legacyRuntimes, rt.path);
      rt.path = path.join(newTomcat, relativePart);
      runtimesUpdated = true;
    }
  }
  if (runtimesUpdated) {
    await context.globalState.update('tomcatRuntimes', runtimes);
    console.log('[Tom Cattery] globalState runtimes 경로 업데이트 완료');
  }

  // 4. 각 서버의 .tom-cattery.json runtimePath 업데이트
  try {
    const serverEntries = await fs.readdir(newServers, { withFileTypes: true });
    for (const entry of serverEntries) {
      if (!entry.isDirectory()) { continue; }
      const metaPath = path.join(newServers, entry.name, '.tom-cattery.json');
      try {
        const content = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(content);
        if (meta.runtimePath && meta.runtimePath.startsWith(legacyRuntimes)) {
          const relativePart = path.relative(legacyRuntimes, meta.runtimePath);
          meta.runtimePath = path.join(newTomcat, relativePart);
          await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
          console.log(`[Tom Cattery] "${entry.name}" runtimePath 업데이트 완료`);
        }
      } catch {
        // 메타 파일 읽기/쓰기 실패 시 스킵
      }
    }
  } catch {
    // newServers 접근 실패
  }

  // 5. 기존 폴더 삭제
  try {
    await fs.rm(legacyBase, { recursive: true, force: true });
    console.log(`[Tom Cattery] 기존 경로 삭제 완료: ${legacyBase}`);
  } catch (err: any) {
    console.warn(`[Tom Cattery] 기존 경로 삭제 실패 (수동 삭제 필요): ${err.message}`);
  }

  console.log('[Tom Cattery] 마이그레이션 완료');
}

/**
 * publisher 변경 시 globalStorageUri 경로가 바뀌므로 이전 데이터를 마이그레이션한다.
 * 예: undefined_publisher.tom-cattery/ → tofu9.tom-cattery/
 *     woongki.tom-cattery/ → tofu9.tom-cattery/
 */
async function migrateFromOldPublisher(context: vscode.ExtensionContext): Promise<void> {
  const newBase = context.globalStorageUri.fsPath;
  const globalStorageParent = path.dirname(newBase);

  // 이전에 사용했을 수 있는 publisher 경로 목록
  const oldPublishers = ['undefined_publisher.tom-cattery', 'woongki.tom-cattery'];

  for (const oldDir of oldPublishers) {
    const oldBase = path.join(globalStorageParent, oldDir);

    // 현재 경로와 같으면 스킵
    if (oldBase === newBase) {
      continue;
    }

    try {
      await fs.access(oldBase);
    } catch {
      continue; // 이전 경로 없으면 스킵
    }

    console.log(`[Tom Cattery] Publisher 마이그레이션: ${oldDir} → ${path.basename(newBase)}`);
    await fs.mkdir(newBase, { recursive: true });

    // servers 디렉터리 이동
    const oldServers = path.join(oldBase, 'servers');
    const newServers = path.join(newBase, 'servers');
    try {
      await fs.access(oldServers);
      await fs.mkdir(newServers, { recursive: true });
      const entries = await fs.readdir(oldServers, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const src = path.join(oldServers, entry.name);
        const dst = path.join(newServers, entry.name);
        try {
          await fs.access(dst);
          console.log(`[Tom Cattery] 서버 "${entry.name}" 이미 존재, 스킵`);
        } catch {
          await fs.rename(src, dst);
          console.log(`[Tom Cattery] 서버 이동: ${entry.name}`);
        }
      }
    } catch { /* servers 없음 */ }

    // tomcat (다운로드된 런타임) 디렉터리 이동
    const oldTomcat = path.join(oldBase, 'tomcat');
    const newTomcat = path.join(newBase, 'tomcat');
    try {
      await fs.access(oldTomcat);
      await fs.mkdir(newTomcat, { recursive: true });
      const entries = await fs.readdir(oldTomcat, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const src = path.join(oldTomcat, entry.name);
        const dst = path.join(newTomcat, entry.name);
        try {
          await fs.access(dst);
        } catch {
          await fs.rename(src, dst);
          console.log(`[Tom Cattery] 런타임 이동: ${entry.name}`);
        }
      }
    } catch { /* tomcat 없음 */ }

    // globalState의 tomcatRuntimes 경로 업데이트
    const runtimes = context.globalState.get<TomcatRuntime[]>('tomcatRuntimes', []);
    let updated = false;
    for (const rt of runtimes) {
      if (rt.path.startsWith(oldBase)) {
        const rel = path.relative(oldBase, rt.path);
        rt.path = path.join(newBase, rel);
        updated = true;
      }
    }
    if (updated) {
      await context.globalState.update('tomcatRuntimes', runtimes);
    }

    // 이전 디렉터리 삭제
    try {
      await fs.rm(oldBase, { recursive: true, force: true });
      console.log(`[Tom Cattery] 이전 경로 삭제: ${oldDir}`);
    } catch (err: any) {
      console.warn(`[Tom Cattery] 이전 경로 삭제 실패: ${err.message}`);
    }
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('Tom Cattery is now active!');

  // 필수 Extension 체크: Debugger for Java
  if (!vscode.extensions.getExtension('vscjava.vscode-java-debug')) {
    vscode.window.showWarningMessage(
      'Tom Cattery: 디버그 기능을 사용하려면 "Debugger for Java" Extension이 필요합니다.',
      'Extension 설치',
    ).then(action => {
      if (action === 'Extension 설치') {
        vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          'vscjava.vscode-java-debug',
        );
      }
    });
  }

  // 기존 경로 → globalStorageUri 마이그레이션
  await migrateFromLegacyPath(context);

  // publisher 변경 시 globalStorage 경로 마이그레이션
  await migrateFromOldPublisher(context);

  const runtimeManager = new RuntimeManager(context);
  const instanceManager = new InstanceManager(context.globalStorageUri.fsPath);
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

        // 사용자가 직접 시작한 경우에만 브라우저 열기 (배포별 context path)
        if (pendingBrowserOpen.delete(name)) {
          const openBrowser = vscode.workspace.getConfiguration('tomCattery')
            .get<boolean>('openBrowserOnStart', true);
          if (openBrowser) {
            const base = `http://localhost:${inst.ports.http}`;
            if (inst.deployments.length === 0) {
              vscode.env.openExternal(vscode.Uri.parse(`${base}/`));
            } else {
              for (const dep of inst.deployments) {
                const ctxPath = dep.contextPath.startsWith('/') ? dep.contextPath : `/${dep.contextPath}`;
                vscode.env.openExternal(vscode.Uri.parse(`${base}${ctxPath}`));
              }
            }
          }
        }
      }
    } else if (status === 'stopped') {
      deployManager!.disposeWatchers(name);
      serverTreeProvider.clearMetrics(name);
    }
  };

  processManager = new ProcessManager(logStreamer, onStatusChange);
  debugController = new DebugController(processManager, instanceManager, logStreamer, onStatusChange);
  configWebviewProvider = new ConfigWebviewProvider(instanceManager, processManager, serverTreeProvider, context.extensionUri);

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
    pendingBrowserOpen,
  );

  // 10초 간격 메트릭 수집 (Uptime + Memory RSS)
  metricsTimer = setInterval(async () => {
    const instances = instanceManager.getInstances();
    const running = instances.filter(i =>
      (i.status === 'running' || i.status === 'debugging') && i.pid,
    );
    if (running.length === 0) { return; }

    for (const inst of running) {
      const rssKb = await MetricsCollector.getRssKb(inst.pid!);
      serverTreeProvider.updateMetrics(inst.name, rssKb);
    }
    serverTreeProvider.refresh();
  }, 10_000);

  // .vscode/tom-cattery.json 감지 → Import 제안
  detectWorkspaceConfig(instanceManager, serverTreeProvider);
}

async function detectWorkspaceConfig(
  instanceManager: InstanceManager,
  treeProvider: ServerTreeProvider,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }

  const configPath = path.join(workspaceRoot, '.vscode', 'tom-cattery.json');
  try {
    await fs.access(configPath);
  } catch {
    return; // 파일 없음
  }

  let exportData: TomCatteryExportData;
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    exportData = JSON.parse(content);
  } catch {
    return; // 파싱 실패
  }

  if (!exportData.version || !Array.isArray(exportData.servers) || exportData.servers.length === 0) {
    return;
  }

  // 현재 등록되지 않은 서버만 필터링
  const existingNames = new Set(instanceManager.getInstances().map(i => i.name));
  const newServers = exportData.servers.filter(s => !existingNames.has(s.name));

  if (newServers.length === 0) { return; }

  const serverNames = newServers.map(s => s.name).join(', ');
  const action = await vscode.window.showInformationMessage(
    `이 프로젝트에 Tomcat 설정이 있습니다 (${newServers.length}개 서버: ${serverNames}). 가져올까요?`,
    '가져오기',
    '무시',
  );

  if (action !== '가져오기') { return; }

  await vscode.commands.executeCommand('tomCattery.importConfig', configPath);
}

export function deactivate() {
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = undefined;
  }
  configWebviewProvider?.dispose();
  deployManager?.disposeAllWatchers();
  debugController?.disposeAll();
  processManager?.killAll();
  logStreamer?.disposeAll();
  console.log('Tom Cattery deactivated');
}
