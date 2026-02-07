import * as vscode from 'vscode';
import * as path from 'path';
import { TomcatInstance, Deployment } from '../types';
import { MetricsCollector } from '../core/MetricsCollector';

export type TreeItem = ServerTreeItem | DeploymentTreeItem;

export class DeploymentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly instance: TomcatInstance,
    public readonly deployment: Deployment,
  ) {
    const label = deployment.warPath.includes('*')
      ? deployment.name
      : path.basename(deployment.warPath, '.war');
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = deployment.contextPath;
    this.contextValue = deployment.autoDeploy ? 'deployment-auto' : 'deployment';
    this.iconPath = deployment.autoDeploy
      ? new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('package');
    this.tooltip = new vscode.MarkdownString(
      `**${deployment.name}**\n\n` +
      `- Context Path: ${deployment.contextPath}\n` +
      `- Type: ${deployment.type}\n` +
      `- WAR: ${deployment.warPath}\n` +
      (deployment.buildTask ? `- Build Task: ${deployment.buildTask}\n` : '') +
      `- Auto Deploy: ${deployment.autoDeploy ? 'On' : 'Off'}\n` +
      (deployment.watchPaths?.length ? `- Watch Paths: ${deployment.watchPaths.join(', ')}\n` : ''),
    );
  }
}

export class ServerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly instance: TomcatInstance,
    rssKb?: number,
  ) {
    super(
      instance.name,
      instance.deployments.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    this.description = instance.pid
      ? `:${instance.ports.http} (PID ${instance.pid})`
      : `:${instance.ports.http}`;
    this.contextValue = `server-${instance.status}`;
    this.iconPath = this.getStatusIcon(instance.status);

    const pidLine = instance.pid ? `- PID: ${instance.pid}\n` : '';
    let metricsLines = '';
    if ((instance.status === 'running' || instance.status === 'debugging') && instance.startedAt) {
      const uptimeMs = Date.now() - instance.startedAt;
      metricsLines += `- Uptime: ${MetricsCollector.formatUptime(uptimeMs)}\n`;
      if (rssKb !== undefined) {
        metricsLines += `- Memory (RSS): ${MetricsCollector.formatMemoryMb(rssKb)}\n`;
      }
    }
    this.tooltip = new vscode.MarkdownString(
      `**${instance.name}** (${instance.status})\n\n` +
      pidLine +
      metricsLines +
      `- HTTP: ${instance.ports.http}\n` +
      `- Shutdown: ${instance.ports.shutdown}\n` +
      `- Debug: ${instance.ports.debug}\n` +
      `- Runtime: ${instance.runtimePath}`,
    );
  }

  private getStatusIcon(status: TomcatInstance['status']): vscode.ThemeIcon {
    switch (status) {
      case 'running':
        return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
      case 'debugging':
        return new vscode.ThemeIcon('bug', new vscode.ThemeColor('charts.green'));
      case 'starting':
      case 'stopping':
        return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
      case 'stopped':
        return new vscode.ThemeIcon('circle-outline');
    }
  }
}

export class ServerTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private servers: TomcatInstance[] = [];
  private metricsCache = new Map<string, number | undefined>();

  updateMetrics(name: string, rssKb: number | undefined): void {
    this.metricsCache.set(name, rssKb);
  }

  clearMetrics(name: string): void {
    this.metricsCache.delete(name);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      return this.servers.map(server =>
        new ServerTreeItem(server, this.metricsCache.get(server.name)),
      );
    }
    if (element instanceof ServerTreeItem) {
      return element.instance.deployments.map(
        dep => new DeploymentTreeItem(element.instance, dep),
      );
    }
    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setServers(servers: TomcatInstance[]): void {
    this.servers = servers;
    this.refresh();
  }

  getServers(): TomcatInstance[] {
    return this.servers;
  }
}
