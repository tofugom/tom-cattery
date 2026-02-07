import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { TomcatInstance } from '../types';
import { LogStreamer } from './LogStreamer';

export class ProcessManager {
  private processes = new Map<string, ChildProcess>();
  private stoppingServers = new Set<string>();

  constructor(
    private logStreamer: LogStreamer,
    private onStatusChange: (name: string, status: TomcatInstance['status'], pid?: number) => void,
  ) {}

  async startServer(instance: TomcatInstance, mode: 'run' | 'jpda' = 'run'): Promise<void> {
    if (this.processes.has(instance.name)) {
      throw new Error(`Server "${instance.name}" is already running`);
    }

    const script = this.getCatalinaScript(instance.runtimePath);
    const env = this.buildEnv(instance);
    const channel = this.logStreamer.getChannel(instance.name);
    const isDebug = mode === 'jpda';

    const args = isDebug ? ['jpda', 'run'] : ['run'];
    const proc = spawn(script, args, {
      env,
      shell: true,
      cwd: instance.basePath,
    });

    this.processes.set(instance.name, proc);
    this.onStatusChange(instance.name, 'starting', proc.pid);

    channel.appendLine(`[Tom Cattery] Starting server "${instance.name}" (mode: ${mode})...`);
    channel.appendLine(`[Tom Cattery] PID = ${proc.pid}`);
    channel.appendLine(`[Tom Cattery] CATALINA_HOME = ${instance.runtimePath}`);
    channel.appendLine(`[Tom Cattery] CATALINA_BASE = ${instance.basePath}`);
    channel.appendLine(`[Tom Cattery] HTTP port = ${instance.ports.http}`);
    if (isDebug) {
      channel.appendLine(`[Tom Cattery] Debug port = ${instance.ports.debug}`);
    }
    channel.appendLine('');
    channel.show(true);

    let startupDetected = false;
    const targetStatus: TomcatInstance['status'] = isDebug ? 'debugging' : 'running';

    const markStarted = (source: string) => {
      if (startupDetected) {
        return;
      }
      startupDetected = true;
      clearInterval(httpPollInterval);
      console.log(`[Tom Cattery] Startup detected (${source})! Transitioning to "${targetStatus}"`);
      this.onStatusChange(instance.name, targetStatus, proc.pid);
    };

    // Method 1: stdout/stderr buffered detection
    let stdoutBuffer = '';
    const checkStartupBuffered = (text: string) => {
      stdoutBuffer += text;
      if (stdoutBuffer.includes('Server startup in') || stdoutBuffer.includes('Catalina.start Server startup')) {
        markStarted('stdout');
      }
      // Keep only last 1KB to avoid memory growth
      if (stdoutBuffer.length > 1024) {
        stdoutBuffer = stdoutBuffer.slice(-512);
      }
    };

    // Method 2: HTTP port polling fallback
    const httpPollInterval = setInterval(() => {
      if (startupDetected) {
        clearInterval(httpPollInterval);
        return;
      }
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.on('connect', () => {
        socket.destroy();
        markStarted('http-poll');
      });
      socket.on('error', () => socket.destroy());
      socket.on('timeout', () => socket.destroy());
      socket.connect(instance.ports.http, 'localhost');
    }, 2000);

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      channel.append(text);
      checkStartupBuffered(text);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      channel.append(text);
      checkStartupBuffered(text);
    });

    proc.on('error', (err) => {
      clearInterval(httpPollInterval);
      channel.appendLine(`[Tom Cattery] Error: ${err.message}`);
      this.processes.delete(instance.name);
      this.stoppingServers.delete(instance.name);
      this.onStatusChange(instance.name, 'stopped', undefined);
    });

    proc.on('close', (code) => {
      clearInterval(httpPollInterval);
      const wasStopping = this.stoppingServers.delete(instance.name);
      this.processes.delete(instance.name);

      if (code !== 0 && code !== null && !wasStopping) {
        channel.appendLine(`[Tom Cattery] Server exited unexpectedly (code: ${code})`);
        vscode.window.showWarningMessage(
          `Server "${instance.name}" exited unexpectedly. Check logs for details.`,
        );
      } else {
        channel.appendLine(`[Tom Cattery] Server stopped.`);
      }

      this.onStatusChange(instance.name, 'stopped', undefined);
    });
  }

  async stopServer(instance: TomcatInstance): Promise<void> {
    const runningProc = this.processes.get(instance.name);
    if (!runningProc) {
      return;
    }

    this.stoppingServers.add(instance.name);
    this.onStatusChange(instance.name, 'stopping');

    const channel = this.logStreamer.getChannel(instance.name);
    channel.appendLine(`[Tom Cattery] Stopping server "${instance.name}"...`);

    // Graceful shutdown via catalina.sh stop
    const script = this.getCatalinaScript(instance.runtimePath);
    const env = this.buildEnv(instance);
    spawn(script, ['stop'], { env, shell: true });

    // Wait for process to exit, force kill after 15s
    return new Promise<void>((resolve) => {
      if (!this.processes.has(instance.name)) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        if (this.processes.has(instance.name)) {
          channel.appendLine('[Tom Cattery] Graceful shutdown timed out, force killing...');
          runningProc.kill('SIGKILL');
        }
        resolve();
      }, 15000);

      runningProc.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async restartServer(instance: TomcatInstance, mode: 'run' | 'jpda' = 'run'): Promise<void> {
    await this.stopServer(instance);
    await this.startServer(instance, mode);
  }

  isRunning(serverName: string): boolean {
    return this.processes.has(serverName);
  }

  killAll(): void {
    for (const [name, proc] of this.processes) {
      proc.kill('SIGKILL');
      this.processes.delete(name);
    }
    this.stoppingServers.clear();
  }

  private getCatalinaScript(runtimePath: string): string {
    const isWindows = process.platform === 'win32';
    const scriptName = isWindows ? 'catalina.bat' : 'catalina.sh';
    return path.join(runtimePath, 'bin', scriptName);
  }

  private buildEnv(instance: TomcatInstance): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CATALINA_HOME: instance.runtimePath,
      CATALINA_BASE: instance.basePath,
      JAVA_HOME: instance.javaHome,
      ...instance.envVars,
    };
  }
}
