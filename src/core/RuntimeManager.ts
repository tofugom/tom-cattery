import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { TomcatRuntime } from '../types';
import { TomcatDownloader, TomcatVersionInfo } from './TomcatDownloader';

export class RuntimeManager {
  private runtimes: TomcatRuntime[] = [];
  private downloader: TomcatDownloader;
  private runtimesDir: string;

  constructor(private context: vscode.ExtensionContext) {
    this.runtimes = context.globalState.get<TomcatRuntime[]>('tomcatRuntimes', []);
    this.runtimesDir = path.join(context.globalStorageUri.fsPath, 'tomcat');
    this.downloader = new TomcatDownloader(this.runtimesDir);
  }

  private async saveRuntimes(): Promise<void> {
    await this.context.globalState.update('tomcatRuntimes', this.runtimes);
  }

  getRuntimes(): TomcatRuntime[] {
    return [...this.runtimes];
  }

  clearRuntimes(): void {
    this.runtimes = [];
  }

  /** 다운로드 / 로컬 선택 분기 */
  async addRuntime(): Promise<TomcatRuntime | undefined> {
    const pick = await vscode.window.showQuickPick([
      { label: '$(cloud-download) Tomcat 다운로드', description: 'Apache에서 최신 버전 다운로드', id: 'download' },
      { label: '$(folder-opened) 로컬 Tomcat 선택', description: '이미 설치된 Tomcat 폴더 선택', id: 'local' },
    ], { placeHolder: 'Tomcat Runtime 추가 방식을 선택하세요' });

    if (!pick) { return undefined; }

    if (pick.id === 'download') {
      return this.downloadRuntime();
    }
    return this.addLocalRuntime();
  }

  /** 로컬 폴더에서 Tomcat 선택 */
  async addLocalRuntime(): Promise<TomcatRuntime | undefined> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Tomcat Home 디렉터리 선택',
    });
    if (!uris || uris.length === 0) {
      return undefined;
    }

    const tomcatPath = uris[0].fsPath;
    return this.registerRuntime(tomcatPath, 'local');
  }

  /** Apache CDN에서 Tomcat 다운로드 */
  async downloadRuntime(): Promise<TomcatRuntime | undefined> {
    // 1. 메이저 버전 선택
    const majorPick = await vscode.window.showQuickPick(
      TomcatDownloader.SUPPORTED_MAJORS.map(v => ({
        label: `Tomcat ${v}`,
        description: v === 11 ? 'Jakarta EE 11' : v === 10 ? 'Jakarta EE 9+' : 'Servlet 4.0',
        majorVersion: v,
      })).reverse(),  // 최신 버전 먼저
      { placeHolder: 'Tomcat 메이저 버전을 선택하세요' },
    );
    if (!majorPick) { return undefined; }

    // 2. 버전 목록 조회
    let versions: TomcatVersionInfo[];
    try {
      versions = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Tomcat ${majorPick.majorVersion} 버전 목록 조회 중...` },
        () => this.downloader.fetchAvailableVersions(majorPick.majorVersion),
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`버전 목록 조회 실패: ${err.message}`);
      return undefined;
    }

    if (versions.length === 0) {
      vscode.window.showWarningMessage(`Tomcat ${majorPick.majorVersion}에서 사용 가능한 버전을 찾을 수 없습니다.`);
      return undefined;
    }

    // 3. 구체 버전 선택
    const versionPick = await vscode.window.showQuickPick(
      versions.map((v, i) => ({
        label: v.version + (i === 0 ? ' (최신)' : ''),
        versionInfo: v,
      })),
      { placeHolder: '다운로드할 버전을 선택하세요' },
    );
    if (!versionPick) { return undefined; }

    const versionInfo = versionPick.versionInfo;

    // 4. 이미 등록된 runtime인지 체크
    const expectedDir = path.join(this.runtimesDir, `apache-tomcat-${versionInfo.version}`);
    const existing = this.runtimes.find(r => r.path === expectedDir);
    if (existing) {
      vscode.window.showInformationMessage(`Tomcat ${existing.version}은 이미 등록되어 있습니다.`);
      return existing;
    }

    // 5. 다운로드 실행 (진행률 표시)
    let downloadedPath: string;
    try {
      downloadedPath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Tomcat ${versionInfo.version} 다운로드 중...`,
          cancellable: false,
        },
        async (progress) => {
          return this.downloader.download(versionInfo, (downloaded, total) => {
            const pct = Math.round((downloaded / total) * 100);
            progress.report({ message: `${pct}%`, increment: 0 });
          });
        },
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`다운로드 실패: ${err.message}`);
      return undefined;
    }

    // 6. 검증 및 등록
    return this.registerRuntime(downloadedPath, 'downloaded');
  }

  /** runtime 검증 후 등록 (공통) */
  private async registerRuntime(tomcatPath: string, type: 'local' | 'downloaded'): Promise<TomcatRuntime | undefined> {
    const existing = this.runtimes.find(r => r.path === tomcatPath);
    if (existing) {
      vscode.window.showInformationMessage(`이 Runtime은 이미 등록되어 있습니다 (${existing.version}).`);
      return existing;
    }

    const validation = await this.validateRuntime(tomcatPath);
    if (!validation.valid) {
      vscode.window.showErrorMessage(`유효하지 않은 Tomcat 디렉터리: ${validation.reason}`);
      return undefined;
    }

    const runtime: TomcatRuntime = {
      version: validation.version!,
      path: tomcatPath,
      type,
      majorVersion: parseInt(validation.version!.split('.')[0]),
    };

    this.runtimes.push(runtime);
    await this.saveRuntimes();
    vscode.window.showInformationMessage(`Tomcat ${runtime.version}이 등록되었습니다.`);
    return runtime;
  }

  async removeRuntime(runtimePath: string): Promise<void> {
    this.runtimes = this.runtimes.filter(r => r.path !== runtimePath);
    await this.saveRuntimes();
  }

  async validateRuntime(tomcatPath: string): Promise<{ valid: boolean; version?: string; reason?: string }> {
    const catalinaJar = path.join(tomcatPath, 'lib', 'catalina.jar');
    try {
      await fs.access(catalinaJar);
    } catch {
      return { valid: false, reason: 'lib/catalina.jar not found' };
    }

    const serverXml = path.join(tomcatPath, 'conf', 'server.xml');
    try {
      await fs.access(serverXml);
    } catch {
      return { valid: false, reason: 'conf/server.xml not found' };
    }

    const version = await this.detectVersion(tomcatPath);
    return { valid: true, version };
  }

  private async detectVersion(tomcatPath: string): Promise<string> {
    try {
      const releaseNotes = path.join(tomcatPath, 'RELEASE-NOTES');
      const content = await fs.readFile(releaseNotes, 'utf-8');
      const match = content.match(/Apache Tomcat Version (\d+\.\d+\.\d+)/);
      if (match) {
        return match[1];
      }
    } catch {
      // RELEASE-NOTES not found, try fallback
    }

    const dirName = path.basename(tomcatPath);
    const match = dirName.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      return match[1];
    }

    return 'unknown';
  }
}
