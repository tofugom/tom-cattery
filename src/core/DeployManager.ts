import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import AdmZip from 'adm-zip';
import { TomcatInstance, Deployment } from '../types';
import { LogStreamer } from './LogStreamer';

const HOT_DEPLOY_EXTENSIONS = new Set([
  '.jsp', '.jspf', '.html', '.htm',
  '.css', '.js', '.ts',
  '.json', '.xml', '.properties', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
]);

export class DeployManager {
  private watchers = new Map<string, vscode.Disposable[]>();
  private buildTimers = new Map<string, NodeJS.Timeout>();
  private logStreamer?: LogStreamer;

  setLogStreamer(logStreamer: LogStreamer): void {
    this.logStreamer = logStreamer;
  }

  // ── Manual Deploy ──

  async deploy(instance: TomcatInstance, deployment: Deployment): Promise<void> {
    // 1. Run build task if configured
    if (deployment.buildTask) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Building ${deployment.buildTask}...` },
        () => this.runBuildTask(deployment.buildTask!),
      );
    }

    // 2. Resolve WAR path (with wildcard support) and check existence
    const warPath = await this.resolveWarPath(deployment.warPath);
    if (!warPath) {
      throw new Error(`WAR file not found: ${this.resolveVariables(deployment.warPath)}`);
    }

    // 3. Map context path to webapps directory name
    const webappDir = this.contextPathToDir(deployment.contextPath);
    const targetPath = path.join(instance.basePath, 'webapps', webappDir);

    // 4. Explode WAR
    const stats = await this.explodeWar(warPath, targetPath);

    // 5. Trigger reload if server is running
    if (instance.status === 'running' || instance.status === 'debugging') {
      await this.triggerReload(instance, deployment.contextPath);
    }

    vscode.window.showInformationMessage(
      `Deployed ${deployment.name} → ${webappDir}/ (${deployment.contextPath}) [${stats.updated} updated, ${stats.removed} removed]`,
    );
  }

  async cleanDeployment(instance: TomcatInstance, deployment: Deployment): Promise<void> {
    const webappDir = this.contextPathToDir(deployment.contextPath);
    const targetPath = path.join(instance.basePath, 'webapps', webappDir);
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
    } catch {
      // Directory might not exist
    }
  }

  async redeployAll(instance: TomcatInstance): Promise<void> {
    if (instance.deployments.length === 0) {
      throw new Error(`No deployments configured for "${instance.name}"`);
    }

    for (const deployment of instance.deployments) {
      await this.deploy(instance, deployment);
    }
  }

  contextPathToDir(contextPath: string): string {
    if (contextPath === '/' || contextPath === '') {
      return 'ROOT';
    }
    // /api → api, /app/v2 → app#v2
    return contextPath.replace(/^\//, '').replace(/\//g, '#');
  }

  // ── Auto Deploy ──

  setupWatchers(instance: TomcatInstance): void {
    this.disposeWatchers(instance.name);

    const channel = this.logStreamer?.getChannel(instance.name);
    const disposables: vscode.Disposable[] = [];

    // Collect watch configs for all autoDeploy deployments
    const watchConfigs: { deployment: Deployment; watchRoot: string }[] = [];

    for (const deployment of instance.deployments) {
      if (!deployment.autoDeploy) {
        continue;
      }

      const watchPaths = deployment.watchPaths && deployment.watchPaths.length > 0
        ? deployment.watchPaths
        : this.inferWatchPaths(deployment.warPath);

      if (watchPaths.length === 0) {
        channel?.appendLine(`[Auto Deploy] No watch paths for "${deployment.name}". Set watchPaths or use standard Gradle layout.`);
        continue;
      }

      for (const watchPath of watchPaths) {
        const resolvedPath = this.resolveVariables(watchPath);
        watchConfigs.push({ deployment, watchRoot: resolvedPath });
        channel?.appendLine(`[Auto Deploy] Watching: ${resolvedPath} → ${deployment.contextPath}`);
      }
    }

    if (watchConfigs.length === 0) {
      channel?.appendLine(`[Tom Cattery] No auto-deploy watchers created. Check autoDeploy settings.`);
      return;
    }

    // Primary: onDidSaveTextDocument — reliable for VSCode editor saves
    const saveListener = vscode.workspace.onDidSaveTextDocument(doc => {
      const filePath = doc.uri.fsPath;
      for (const { deployment, watchRoot } of watchConfigs) {
        if (filePath.startsWith(watchRoot + '/') || filePath.startsWith(watchRoot + '\\')) {
          this.onFileChanged(instance, deployment, filePath, watchRoot, channel);
          return;
        }
      }
    });
    disposables.push(saveListener);

    // Secondary: FileSystemWatcher — catches external changes (file copy, git checkout, etc.)
    for (const { deployment, watchRoot } of watchConfigs) {
      const baseUri = vscode.Uri.file(watchRoot);
      const pattern = new vscode.RelativePattern(baseUri, '**/*');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      watcher.onDidChange(uri => {
        this.onFileChanged(instance, deployment, uri.fsPath, watchRoot, channel);
      });
      watcher.onDidCreate(uri => {
        this.onFileChanged(instance, deployment, uri.fsPath, watchRoot, channel);
      });
      watcher.onDidDelete(uri => {
        this.onFileDeleted(instance, deployment, uri.fsPath, watchRoot, channel);
      });

      disposables.push(watcher);
    }

    this.watchers.set(instance.name, disposables);
    channel?.appendLine(`[Tom Cattery] Auto-deploy watchers active (${watchConfigs.length} path(s)).`);
  }

  disposeWatchers(serverName: string): void {
    const existing = this.watchers.get(serverName);
    if (existing) {
      for (const d of existing) {
        d.dispose();
      }
      this.watchers.delete(serverName);
    }
    // Clear any pending build timers (key format: "serverName:contextPath")
    for (const [key, timer] of this.buildTimers) {
      if (key.startsWith(`${serverName}:`)) {
        clearTimeout(timer);
        this.buildTimers.delete(key);
      }
    }
  }

  disposeAllWatchers(): void {
    for (const [name] of this.watchers) {
      this.disposeWatchers(name);
    }
  }

  inferWatchPaths(warPath: string): string[] {
    // e.g. /project/sample/build/libs/sample.war → /project/sample/src/main/webapp
    const resolved = this.resolveVariables(warPath);
    const buildLibsIdx = resolved.indexOf(path.join('build', 'libs'));
    if (buildLibsIdx > 0) {
      const moduleRoot = resolved.substring(0, buildLibsIdx);
      return [path.join(moduleRoot, 'src', 'main', 'webapp')];
    }
    return [];
  }

  private onFileChanged(
    instance: TomcatInstance,
    deployment: Deployment,
    filePath: string,
    watchRoot: string,
    channel?: vscode.OutputChannel,
  ): void {
    const ext = path.extname(filePath).toLowerCase();

    if (HOT_DEPLOY_EXTENSIONS.has(ext)) {
      // Hot sync: immediate copy
      this.syncSingleFile(instance, deployment, filePath, watchRoot, channel);
    } else if (ext === '.java') {
      // Java source: debounced build + redeploy
      this.debouncedBuild(instance, deployment, channel);
    }
  }

  private async onFileDeleted(
    instance: TomcatInstance,
    deployment: Deployment,
    filePath: string,
    watchRoot: string,
    channel?: vscode.OutputChannel,
  ): Promise<void> {
    const relativePath = path.relative(watchRoot, filePath);
    const webappDir = this.contextPathToDir(deployment.contextPath);
    const targetFile = path.join(instance.basePath, 'webapps', webappDir, relativePath);

    try {
      await fs.unlink(targetFile);
      channel?.appendLine(`[Auto Deploy] Deleted: ${relativePath}`);
    } catch {
      // Target file might not exist
    }
  }

  private async syncSingleFile(
    instance: TomcatInstance,
    deployment: Deployment,
    filePath: string,
    watchRoot: string,
    channel?: vscode.OutputChannel,
  ): Promise<void> {
    const relativePath = path.relative(watchRoot, filePath);
    const webappDir = this.contextPathToDir(deployment.contextPath);
    const targetFile = path.join(instance.basePath, 'webapps', webappDir, relativePath);

    try {
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.copyFile(filePath, targetFile);
      channel?.appendLine(`[Hot Sync] ${relativePath}`);
    } catch (err: any) {
      channel?.appendLine(`[Hot Sync] Error: ${relativePath} — ${err.message}`);
    }
  }

  private debouncedBuild(
    instance: TomcatInstance,
    deployment: Deployment,
    channel?: vscode.OutputChannel,
  ): void {
    const key = `${instance.name}:${deployment.contextPath}`;
    const existing = this.buildTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      this.buildTimers.delete(key);
      channel?.appendLine(`[Auto Deploy] Java source changed. Building and redeploying...`);
      try {
        await this.deploy(instance, deployment);
      } catch (err: any) {
        channel?.appendLine(`[Auto Deploy] Build failed: ${err.message}`);
      }
    }, 1000);

    this.buildTimers.set(key, timer);
  }

  // ── Internal helpers ──

  private async explodeWar(
    warPath: string,
    targetPath: string,
  ): Promise<{ updated: number; removed: number }> {
    const zip = new AdmZip(warPath);
    const entries = zip.getEntries();

    let targetExists = true;
    try {
      await fs.access(targetPath);
    } catch {
      targetExists = false;
    }

    if (!targetExists) {
      await fs.mkdir(targetPath, { recursive: true });
      zip.extractAllTo(targetPath, true);
      const fileCount = entries.filter(e => !e.isDirectory).length;
      return { updated: fileCount, removed: 0 };
    }

    let updated = 0;
    let removed = 0;
    const warFiles = new Set<string>();

    for (const entry of entries) {
      if (entry.isDirectory) {
        continue;
      }

      warFiles.add(entry.entryName);
      const filePath = path.join(targetPath, entry.entryName);

      if (await this.needsUpdate(filePath, entry)) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, entry.getData());
        updated++;
      }
    }

    const existingFiles = await this.listFilesRecursive(targetPath);
    for (const existing of existingFiles) {
      const relativePath = path.relative(targetPath, existing).split(path.sep).join('/');
      if (!warFiles.has(relativePath)) {
        await fs.unlink(existing);
        removed++;
      }
    }

    return { updated, removed };
  }

  private async needsUpdate(filePath: string, entry: AdmZip.IZipEntry): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size !== entry.header.size) {
        return true;
      }
      const existingData = await fs.readFile(filePath);
      const newData = entry.getData();
      return !existingData.equals(newData);
    } catch {
      return true;
    }
  }

  private async listFilesRecursive(dir: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.listFilesRecursive(fullPath));
      } else {
        files.push(fullPath);
      }
    }
    return files;
  }

  private async triggerReload(instance: TomcatInstance, contextPath: string): Promise<void> {
    const webappDir = this.contextPathToDir(contextPath);
    const contextXml = path.join(
      instance.basePath, 'webapps', webappDir, 'META-INF', 'context.xml',
    );
    try {
      const now = new Date();
      await fs.utimes(contextXml, now, now);
    } catch {
      // context.xml might not exist, that's OK
    }
  }

  private async runBuildTask(taskName: string): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

    const task = new vscode.Task(
      { type: 'shell', task: taskName },
      vscode.TaskScope.Workspace,
      `Build ${taskName}`,
      'Tom Cattery',
      new vscode.ShellExecution(`${gradlew} ${taskName}`, { cwd: workspaceRoot }),
    );

    return new Promise((resolve, reject) => {
      vscode.tasks.executeTask(task).then(exec => {
        const disposable = vscode.tasks.onDidEndTaskProcess(e => {
          if (e.execution === exec) {
            disposable.dispose();
            if (e.exitCode === 0) {
              resolve();
            } else {
              reject(new Error(`Build failed (exit code: ${e.exitCode})`));
            }
          }
        });
      });
    });
  }

  /**
   * WAR 경로를 해석한다.
   * - 와일드카드(*.war)가 포함된 경우: glob 매칭하여 최신 WAR 파일 반환
   * - 정확한 파일명인 경우: 그대로 반환
   */
  async resolveWarPath(rawPath: string): Promise<string | undefined> {
    const resolved = this.resolveVariables(rawPath);

    if (!resolved.includes('*')) {
      // 정확한 경로
      try {
        await fs.access(resolved);
        return resolved;
      } catch {
        return undefined;
      }
    }

    // 와일드카드 경로: 디렉터리 + 패턴 분리
    const dir = path.dirname(resolved);
    const pattern = path.basename(resolved); // 예: "*.war" 또는 "module-name*.war"
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special chars (except *)
      .replace(/\*/g, '.*');                  // * → .*
    const regex = new RegExp(`^${regexStr}$`);

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const matches: { name: string; mtime: number }[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) { continue; }
        if (regex.test(entry.name)) {
          const stat = await fs.stat(path.join(dir, entry.name));
          matches.push({ name: entry.name, mtime: stat.mtimeMs });
        }
      }

      if (matches.length === 0) {
        return undefined;
      }

      // 가장 최근 수정된 파일 반환
      matches.sort((a, b) => b.mtime - a.mtime);
      return path.join(dir, matches[0].name);
    } catch {
      return undefined;
    }
  }

  private resolveVariables(p: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return p.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
  }
}
