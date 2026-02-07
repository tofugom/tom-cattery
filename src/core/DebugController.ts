import * as vscode from 'vscode';
import * as net from 'net';
import { TomcatInstance } from '../types';
import { ProcessManager } from './ProcessManager';
import { InstanceManager } from './InstanceManager';
import { LogStreamer } from './LogStreamer';

export class DebugController {
  private debugSessions = new Map<string, vscode.Disposable>();

  constructor(
    private processManager: ProcessManager,
    private instanceManager: InstanceManager,
    private logStreamer: LogStreamer,
    private onStatusChange: (name: string, status: TomcatInstance['status'], pid?: number) => void,
  ) {}

  async debugServer(instance: TomcatInstance): Promise<void> {
    if (this.processManager.isRunning(instance.name)) {
      throw new Error(`Server "${instance.name}" is already running`);
    }

    const debugPort = instance.debug.port || instance.ports.debug;
    const channel = this.logStreamer.getChannel(instance.name);

    // 1. Check port availability
    channel.appendLine(`[Tom Cattery] Checking debug port ${debugPort}...`);
    await this.ensurePortAvailable(debugPort);

    // 2. Inject JPDA config into setenv.sh
    channel.appendLine(`[Tom Cattery] Injecting JPDA config (port: ${debugPort}, suspend: ${instance.debug.suspend})...`);
    await this.instanceManager.injectJpdaConfig(instance, debugPort, instance.debug.suspend);

    // 3. Start server in JPDA mode
    await this.processManager.startServer(instance, 'jpda');

    // 4. Wait for JPDA port to be ready
    channel.appendLine(`[Tom Cattery] Waiting for JPDA debugger port ${debugPort}...`);
    try {
      await this.waitForJpdaReady(debugPort, 30000);
    } catch {
      channel.appendLine(`[Tom Cattery] JPDA port not ready after 30 seconds. Debugger may not attach automatically.`);
      vscode.window.showWarningMessage(
        `JPDA debugger port ${debugPort} not ready after 30 seconds. Check server logs.`,
      );
      return;
    }

    // 5. Auto-attach debugger
    channel.appendLine(`[Tom Cattery] JPDA ready. Attaching debugger...`);
    const attached = await this.attachDebugger(instance, debugPort);
    if (attached) {
      channel.appendLine(`[Tom Cattery] Debugger attached to "${instance.name}" (port ${debugPort}).`);
      vscode.window.showInformationMessage(
        `Debugger attached to "${instance.name}" (port ${debugPort}).`,
      );
    } else {
      channel.appendLine(`[Tom Cattery] Failed to attach debugger. Is "Debugger for Java" extension installed?`);
      vscode.window.showWarningMessage(
        `Failed to attach debugger. Ensure "Debugger for Java" extension is installed.`,
      );
    }
  }

  private ensurePortAvailable(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Debug port ${port} is already in use`));
        } else {
          reject(err);
        }
      });
      server.once('listening', () => {
        server.close(() => resolve());
      });
      server.listen(port, 'localhost');
    });
  }

  private waitForJpdaReady(port: number, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const tryConnect = () => {
        if (Date.now() - startTime > timeout) {
          reject(new Error(`Timeout waiting for JPDA port ${port}`));
          return;
        }

        const socket = new net.Socket();
        socket.setTimeout(1000);

        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });

        socket.on('error', () => {
          socket.destroy();
          setTimeout(tryConnect, 500);
        });

        socket.on('timeout', () => {
          socket.destroy();
          setTimeout(tryConnect, 500);
        });

        socket.connect(port, 'localhost');
      };

      tryConnect();
    });
  }

  private async attachDebugger(instance: TomcatInstance, debugPort: number): Promise<boolean> {
    const debugConfig: vscode.DebugConfiguration = {
      type: 'java',
      request: 'attach',
      name: `Tom Cattery: ${instance.name}`,
      hostName: 'localhost',
      port: debugPort,
    };

    const folder = vscode.workspace.workspaceFolders?.[0];
    const success = await vscode.debug.startDebugging(folder, debugConfig);

    if (success) {
      // Listen for debug session termination
      const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.name === debugConfig.name) {
          this.onDebugSessionEnd(instance);
          disposable.dispose();
          this.debugSessions.delete(instance.name);
        }
      });
      this.debugSessions.set(instance.name, disposable);
    }

    return success;
  }

  private async onDebugSessionEnd(instance: TomcatInstance): Promise<void> {
    const channel = this.logStreamer.getChannel(instance.name);
    channel.appendLine(`[Tom Cattery] Debug session ended for "${instance.name}".`);

    // Clean up JPDA config
    try {
      await this.instanceManager.removeJpdaConfig(instance);
    } catch {
      // Best effort cleanup
    }
  }

  disposeAll(): void {
    for (const [, disposable] of this.debugSessions) {
      disposable.dispose();
    }
    this.debugSessions.clear();
  }
}
