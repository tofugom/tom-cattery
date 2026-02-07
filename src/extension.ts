import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { TomcatInstance, TomcatRuntime } from './types';
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

        // 사용자가 직접 시작한 경우에만 브라우저 열기
        if (pendingBrowserOpen.delete(name)) {
          const openBrowser = vscode.workspace.getConfiguration('tomCattery')
            .get<boolean>('openBrowserOnStart', true);
          if (openBrowser) {
            vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${inst.ports.http}/`));
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
