import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { TomcatRuntime } from '../types';

export class RuntimeManager {
  private runtimes: TomcatRuntime[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.runtimes = context.globalState.get<TomcatRuntime[]>('tomcatRuntimes', []);
  }

  private async saveRuntimes(): Promise<void> {
    await this.context.globalState.update('tomcatRuntimes', this.runtimes);
  }

  getRuntimes(): TomcatRuntime[] {
    return [...this.runtimes];
  }

  async addRuntime(): Promise<TomcatRuntime | undefined> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Tomcat Home Directory',
    });
    if (!uris || uris.length === 0) {
      return undefined;
    }

    const tomcatPath = uris[0].fsPath;

    const existing = this.runtimes.find(r => r.path === tomcatPath);
    if (existing) {
      vscode.window.showInformationMessage(`This runtime is already registered (${existing.version}).`);
      return existing;
    }

    const validation = await this.validateRuntime(tomcatPath);
    if (!validation.valid) {
      vscode.window.showErrorMessage(`Invalid Tomcat directory: ${validation.reason}`);
      return undefined;
    }

    const runtime: TomcatRuntime = {
      version: validation.version!,
      path: tomcatPath,
      type: 'local',
      majorVersion: parseInt(validation.version!.split('.')[0]),
    };

    this.runtimes.push(runtime);
    await this.saveRuntimes();
    vscode.window.showInformationMessage(`Tomcat ${runtime.version} registered.`);
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
