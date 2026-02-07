import * as path from 'path';
import * as fs from 'fs/promises';
import { TomcatInstance, TomcatRuntime, PortConfig, Deployment, TimeoutConfig } from '../types';
import { ConfigParser } from './ConfigParser';

export class InstanceManager {
  readonly baseDir: string;
  private instances: TomcatInstance[] = [];

  constructor(globalStoragePath: string) {
    this.baseDir = path.join(globalStoragePath, 'servers');
  }

  async loadInstances(): Promise<TomcatInstance[]> {
    this.instances = [];

    try {
      await fs.access(this.baseDir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(this.baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const metaPath = path.join(this.baseDir, entry.name, '.tom-cattery.json');
      try {
        const content = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(content);
        this.instances.push({
          name: meta.name,
          basePath: path.join(this.baseDir, entry.name),
          runtimePath: meta.runtimePath,
          ports: {
            http: meta.httpPort,
            https: meta.httpsPort,
            shutdown: meta.shutdownPort,
            ajp: meta.ajpPort,
            debug: meta.debugPort,
          },
          javaHome: meta.javaHome || '',
          javaHomeName: meta.javaHomeName || undefined,
          jvmArgs: meta.jvmArgs ? meta.jvmArgs.split(' ').filter(Boolean) : [],
          envVars: meta.envVars || {},
          deployments: meta.deployments || [],
          debug: meta.debug || {
            enabled: true,
            port: meta.debugPort,
            suspend: false,
            autoAttach: true,
            sourcePaths: [],
          },
          timeouts: meta.timeouts || { start: 45, stop: 15 },
          status: 'stopped',
        });
      } catch {
        // Skip malformed metadata
      }
    }

    return this.instances;
  }

  getInstances(): TomcatInstance[] {
    return [...this.instances];
  }

  updateStatus(name: string, status: TomcatInstance['status'], pid?: number): void {
    const instance = this.instances.find(i => i.name === name);
    if (instance) {
      instance.status = status;
      instance.pid = pid;
      if (status === 'running' || status === 'debugging') {
        instance.startedAt = Date.now();
      } else if (status === 'stopped') {
        instance.startedAt = undefined;
      }
    }
  }

  async createInstance(
    name: string,
    runtime: TomcatRuntime,
    ports: PortConfig,
    javaHome: string,
    javaHomeName?: string,
  ): Promise<TomcatInstance> {
    const instanceDir = path.join(this.baseDir, name);

    // Create directory structure
    const dirs = ['conf', 'bin', 'webapps', 'logs', 'work', 'temp'];
    for (const dir of dirs) {
      await fs.mkdir(path.join(instanceDir, dir), { recursive: true });
    }

    // Copy conf files from CATALINA_HOME
    await this.copyDir(
      path.join(runtime.path, 'conf'),
      path.join(instanceDir, 'conf'),
    );

    // Patch server.xml ports
    await ConfigParser.patchServerXmlPorts(
      path.join(instanceDir, 'conf', 'server.xml'),
      ports,
    );

    // Patch context.xml for development (reloadable=true)
    await ConfigParser.patchContextXml(
      path.join(instanceDir, 'conf', 'context.xml'),
    );

    // Create setenv.sh / setenv.bat
    await this.createSetenvSh(instanceDir, name, javaHome);
    await this.createSetenvBat(instanceDir, name, javaHome);

    // Save metadata
    const metadata = {
      name,
      runtimePath: runtime.path,
      httpPort: ports.http,
      httpsPort: ports.https,
      shutdownPort: ports.shutdown,
      ajpPort: ports.ajp,
      debugPort: ports.debug,
      javaHome,
      javaHomeName: javaHomeName || undefined,
      jvmArgs: '',
      envVars: {},
      deployments: [],
      debug: {
        enabled: true,
        port: ports.debug,
        suspend: false,
        autoAttach: true,
        sourcePaths: [],
      },
      timeouts: { start: 45, stop: 15 },
      createdAt: new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(instanceDir, '.tom-cattery.json'),
      JSON.stringify(metadata, null, 2),
      'utf-8',
    );

    const instance: TomcatInstance = {
      name,
      basePath: instanceDir,
      runtimePath: runtime.path,
      ports,
      javaHome,
      javaHomeName,
      jvmArgs: [],
      envVars: {},
      deployments: [],
      debug: metadata.debug,
      timeouts: metadata.timeouts,
      status: 'stopped',
    };

    this.instances.push(instance);
    return instance;
  }

  async addDeployment(serverName: string, deployment: Deployment): Promise<void> {
    const instance = this.instances.find(i => i.name === serverName);
    if (!instance) {
      throw new Error(`Server "${serverName}" not found`);
    }

    // Replace existing deployment with same context path
    instance.deployments = instance.deployments.filter(
      d => d.contextPath !== deployment.contextPath,
    );
    instance.deployments.push(deployment);

    await this.saveMetadata(instance);
  }

  async removeDeployment(serverName: string, contextPath: string): Promise<void> {
    const instance = this.instances.find(i => i.name === serverName);
    if (!instance) {
      return;
    }
    instance.deployments = instance.deployments.filter(d => d.contextPath !== contextPath);
    await this.saveMetadata(instance);
  }

  private async saveMetadata(instance: TomcatInstance): Promise<void> {
    const metaPath = path.join(instance.basePath, '.tom-cattery.json');
    const content = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(content);
    meta.deployments = instance.deployments;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  /**
   * Save full config: updates .tom-cattery.json, server.xml ports, and setenv.sh/bat.
   * Returns the old PortConfig so callers can detect changes.
   */
  async saveFullConfig(instance: TomcatInstance): Promise<{ oldPorts: PortConfig }> {
    const metaPath = path.join(instance.basePath, '.tom-cattery.json');
    const content = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(content);

    const oldPorts: PortConfig = {
      http: meta.httpPort,
      https: meta.httpsPort,
      shutdown: meta.shutdownPort,
      ajp: meta.ajpPort,
      debug: meta.debugPort,
    };

    // Update metadata
    meta.httpPort = instance.ports.http;
    meta.httpsPort = instance.ports.https;
    meta.shutdownPort = instance.ports.shutdown;
    meta.ajpPort = instance.ports.ajp;
    meta.debugPort = instance.ports.debug;
    meta.javaHome = instance.javaHome;
    meta.javaHomeName = instance.javaHomeName || undefined;
    meta.jvmArgs = instance.jvmArgs.join(' ');
    meta.envVars = instance.envVars;
    meta.debug = instance.debug;
    meta.timeouts = instance.timeouts;
    meta.deployments = instance.deployments;

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    // Patch server.xml if ports changed
    const portsChanged = Object.keys(oldPorts).some(
      k => oldPorts[k as keyof PortConfig] !== instance.ports[k as keyof PortConfig],
    );
    if (portsChanged) {
      const serverXmlPath = path.join(instance.basePath, 'conf', 'server.xml');
      await ConfigParser.updateServerXmlPorts(serverXmlPath, oldPorts, instance.ports);
    }

    // Regenerate setenv.sh/bat with current JVM args, env vars, and JAVA_HOME
    await this.regenerateSetenvSh(instance);
    await this.regenerateSetenvBat(instance);

    return { oldPorts };
  }

  getInstance(name: string): TomcatInstance | undefined {
    return this.instances.find(i => i.name === name);
  }

  private static readonly SETENV_MARKER_START = '# ===== TOM CATTERY SETENV CONFIG (auto-managed) =====';
  private static readonly SETENV_MARKER_END = '# ===== END TOM CATTERY SETENV CONFIG =====';
  private static readonly SETENV_MARKER_REGEX = /# ===== TOM CATTERY SETENV CONFIG.*?# ===== END TOM CATTERY SETENV CONFIG =====/s;

  private static readonly SETENV_BAT_MARKER_START = 'rem ===== TOM CATTERY SETENV CONFIG (auto-managed) =====';
  private static readonly SETENV_BAT_MARKER_END = 'rem ===== END TOM CATTERY SETENV CONFIG =====';
  private static readonly SETENV_BAT_MARKER_REGEX = /rem ===== TOM CATTERY SETENV CONFIG.*?rem ===== END TOM CATTERY SETENV CONFIG =====/s;

  private async regenerateSetenvSh(instance: TomcatInstance): Promise<void> {
    const shPath = path.join(instance.basePath, 'bin', 'setenv.sh');

    const jvmLines = instance.jvmArgs.length > 0
      ? instance.jvmArgs.map(arg => `CATALINA_OPTS="$CATALINA_OPTS ${arg}"`).join('\n')
      : 'CATALINA_OPTS="$CATALINA_OPTS -Xms256m"\nCATALINA_OPTS="$CATALINA_OPTS -Xmx1024m"\nCATALINA_OPTS="$CATALINA_OPTS -Dfile.encoding=UTF-8"';

    const envLines = Object.entries(instance.envVars)
      .map(([k, v]) => `export ${k}="${v}"`)
      .join('\n');

    const block = [
      InstanceManager.SETENV_MARKER_START,
      `export JAVA_HOME="${instance.javaHome}"`,
      '',
      '# JVM Options',
      jvmLines,
      'export CATALINA_OPTS',
      ...(envLines ? ['', '# Environment Variables', envLines] : []),
      InstanceManager.SETENV_MARKER_END,
    ].join('\n');

    try {
      let content = await fs.readFile(shPath, 'utf-8');
      if (InstanceManager.SETENV_MARKER_REGEX.test(content)) {
        content = content.replace(InstanceManager.SETENV_MARKER_REGEX, block);
      } else {
        // Replace the default generated content with marker-managed block
        const header = content.split('\n').filter(l =>
          l.startsWith('#!/bin/bash') || l.startsWith('# Generated by Tom Cattery'),
        ).join('\n');
        content = header + '\n\n' + block + '\n';
      }
      await fs.writeFile(shPath, content, { mode: 0o755 });
    } catch {
      // File doesn't exist, create fresh
      const content = [
        '#!/bin/bash',
        `# Generated by Tom Cattery - Server: ${instance.name}`,
        '',
        block,
        '',
      ].join('\n');
      await fs.writeFile(shPath, content, { mode: 0o755 });
    }
  }

  private async regenerateSetenvBat(instance: TomcatInstance): Promise<void> {
    const batPath = path.join(instance.basePath, 'bin', 'setenv.bat');

    const jvmLines = instance.jvmArgs.length > 0
      ? instance.jvmArgs.map(arg => `set "CATALINA_OPTS=%CATALINA_OPTS% ${arg}"`).join('\r\n')
      : 'set "CATALINA_OPTS=%CATALINA_OPTS% -Xms256m"\r\nset "CATALINA_OPTS=%CATALINA_OPTS% -Xmx1024m"\r\nset "CATALINA_OPTS=%CATALINA_OPTS% -Dfile.encoding=UTF-8"';

    const envLines = Object.entries(instance.envVars)
      .map(([k, v]) => `set "${k}=${v}"`)
      .join('\r\n');

    const block = [
      InstanceManager.SETENV_BAT_MARKER_START,
      `set "JAVA_HOME=${instance.javaHome}"`,
      '',
      'rem JVM Options',
      jvmLines,
      ...(envLines ? ['', 'rem Environment Variables', envLines] : []),
      InstanceManager.SETENV_BAT_MARKER_END,
    ].join('\r\n');

    try {
      let content = await fs.readFile(batPath, 'utf-8');
      if (InstanceManager.SETENV_BAT_MARKER_REGEX.test(content)) {
        content = content.replace(InstanceManager.SETENV_BAT_MARKER_REGEX, block);
      } else {
        const header = content.split(/\r?\n/).filter(l =>
          l.startsWith('@echo off') || l.startsWith('rem Generated by Tom Cattery'),
        ).join('\r\n');
        content = header + '\r\n\r\n' + block + '\r\n';
      }
      await fs.writeFile(batPath, content);
    } catch {
      const content = [
        '@echo off',
        `rem Generated by Tom Cattery - Server: ${instance.name}`,
        '',
        block,
        '',
      ].join('\r\n');
      await fs.writeFile(batPath, content);
    }
  }

  async cloneInstance(sourceName: string, newName: string, newPorts: PortConfig): Promise<TomcatInstance> {
    const source = this.instances.find(i => i.name === sourceName);
    if (!source) {
      throw new Error(`소스 서버 "${sourceName}"을 찾을 수 없습니다.`);
    }

    const sourceDir = path.join(this.baseDir, sourceName);
    const newDir = path.join(this.baseDir, newName);

    // 1. 전체 디렉토리 복사
    await this.copyDir(sourceDir, newDir);

    // 2. webapps, logs, work, temp 클린업 (배포/캐시는 복제하지 않음)
    for (const dir of ['webapps', 'logs', 'work', 'temp']) {
      const dirPath = path.join(newDir, dir);
      await fs.rm(dirPath, { recursive: true, force: true });
      await fs.mkdir(dirPath, { recursive: true });
    }

    // 3. server.xml 포트 패치 (소스 포트 → 새 포트)
    const serverXmlPath = path.join(newDir, 'conf', 'server.xml');
    await ConfigParser.updateServerXmlPorts(serverXmlPath, source.ports, newPorts);

    // 4. .tom-cattery.json 업데이트
    const metaPath = path.join(newDir, '.tom-cattery.json');
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaContent);
    meta.name = newName;
    meta.httpPort = newPorts.http;
    meta.httpsPort = newPorts.https;
    meta.shutdownPort = newPorts.shutdown;
    meta.ajpPort = newPorts.ajp;
    meta.debugPort = newPorts.debug;
    meta.debug = { ...meta.debug, port: newPorts.debug };
    meta.deployments = []; // 배포 설정은 초기화
    meta.createdAt = new Date().toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    // 5. setenv.sh/bat 재생성
    const newInstance: TomcatInstance = {
      name: newName,
      basePath: newDir,
      runtimePath: source.runtimePath,
      ports: newPorts,
      javaHome: source.javaHome,
      javaHomeName: source.javaHomeName,
      jvmArgs: [...source.jvmArgs],
      envVars: { ...source.envVars },
      deployments: [],
      debug: { ...source.debug, port: newPorts.debug },
      timeouts: { ...source.timeouts },
      status: 'stopped',
    };

    await this.regenerateSetenvSh(newInstance);
    await this.regenerateSetenvBat(newInstance);

    this.instances.push(newInstance);
    return newInstance;
  }

  async deleteInstance(name: string): Promise<void> {
    const instanceDir = path.join(this.baseDir, name);
    await fs.rm(instanceDir, { recursive: true, force: true });
    this.instances = this.instances.filter(i => i.name !== name);
  }

  private static readonly JPDA_MARKER_START = '# ===== TOM CATTERY DEBUG CONFIG (auto-managed) =====';
  private static readonly JPDA_MARKER_END = '# ===== END TOM CATTERY DEBUG CONFIG =====';
  private static readonly JPDA_MARKER_REGEX = /# ===== TOM CATTERY DEBUG CONFIG.*?# ===== END TOM CATTERY DEBUG CONFIG =====/s;

  private static readonly JPDA_BAT_MARKER_START = 'rem ===== TOM CATTERY DEBUG CONFIG (auto-managed) =====';
  private static readonly JPDA_BAT_MARKER_END = 'rem ===== END TOM CATTERY DEBUG CONFIG =====';
  private static readonly JPDA_BAT_MARKER_REGEX = /rem ===== TOM CATTERY DEBUG CONFIG.*?rem ===== END TOM CATTERY DEBUG CONFIG =====/s;

  async injectJpdaConfig(instance: TomcatInstance, debugPort: number, suspend: boolean): Promise<void> {
    // setenv.sh
    const shPath = path.join(instance.basePath, 'bin', 'setenv.sh');
    const shBlock = [
      InstanceManager.JPDA_MARKER_START,
      `export JPDA_ADDRESS="*:${debugPort}"`,
      'export JPDA_TRANSPORT="dt_socket"',
      `export JPDA_SUSPEND="${suspend ? 'y' : 'n'}"`,
      InstanceManager.JPDA_MARKER_END,
    ].join('\n');

    let shContent = await fs.readFile(shPath, 'utf-8');
    if (InstanceManager.JPDA_MARKER_REGEX.test(shContent)) {
      shContent = shContent.replace(InstanceManager.JPDA_MARKER_REGEX, shBlock);
    } else {
      shContent += '\n' + shBlock + '\n';
    }
    await fs.writeFile(shPath, shContent, { mode: 0o755 });

    // setenv.bat
    const batPath = path.join(instance.basePath, 'bin', 'setenv.bat');
    const batBlock = [
      InstanceManager.JPDA_BAT_MARKER_START,
      `set "JPDA_ADDRESS=*:${debugPort}"`,
      'set "JPDA_TRANSPORT=dt_socket"',
      `set "JPDA_SUSPEND=${suspend ? 'y' : 'n'}"`,
      InstanceManager.JPDA_BAT_MARKER_END,
    ].join('\r\n');

    let batContent = await fs.readFile(batPath, 'utf-8');
    if (InstanceManager.JPDA_BAT_MARKER_REGEX.test(batContent)) {
      batContent = batContent.replace(InstanceManager.JPDA_BAT_MARKER_REGEX, batBlock);
    } else {
      batContent += '\r\n' + batBlock + '\r\n';
    }
    await fs.writeFile(batPath, batContent);
  }

  async removeJpdaConfig(instance: TomcatInstance): Promise<void> {
    const shPath = path.join(instance.basePath, 'bin', 'setenv.sh');
    try {
      let shContent = await fs.readFile(shPath, 'utf-8');
      shContent = shContent.replace(InstanceManager.JPDA_MARKER_REGEX, '').replace(/\n{3,}/g, '\n\n');
      await fs.writeFile(shPath, shContent, { mode: 0o755 });
    } catch { /* file might not exist */ }

    const batPath = path.join(instance.basePath, 'bin', 'setenv.bat');
    try {
      let batContent = await fs.readFile(batPath, 'utf-8');
      batContent = batContent.replace(InstanceManager.JPDA_BAT_MARKER_REGEX, '').replace(/(\r\n){3,}/g, '\r\n\r\n');
      await fs.writeFile(batPath, batContent);
    } catch { /* file might not exist */ }
  }

  private async copyDir(src: string, dst: string): Promise<void> {
    await fs.mkdir(dst, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        await this.copyDir(srcPath, dstPath);
      } else {
        await fs.copyFile(srcPath, dstPath);
      }
    }
  }

  private async createSetenvSh(
    instanceDir: string,
    name: string,
    javaHome: string,
  ): Promise<void> {
    const content = [
      '#!/bin/bash',
      `# Generated by Tom Cattery - Server: ${name}`,
      '',
      '# Java Home',
      `export JAVA_HOME="${javaHome}"`,
      '',
      '# JVM Options',
      'CATALINA_OPTS="$CATALINA_OPTS -Xms256m"',
      'CATALINA_OPTS="$CATALINA_OPTS -Xmx1024m"',
      'CATALINA_OPTS="$CATALINA_OPTS -Dfile.encoding=UTF-8"',
      'export CATALINA_OPTS',
      '',
    ].join('\n');

    await fs.writeFile(path.join(instanceDir, 'bin', 'setenv.sh'), content, { mode: 0o755 });
  }

  private async createSetenvBat(
    instanceDir: string,
    name: string,
    javaHome: string,
  ): Promise<void> {
    const content = [
      '@echo off',
      `rem Generated by Tom Cattery - Server: ${name}`,
      '',
      'rem Java Home',
      `set "JAVA_HOME=${javaHome}"`,
      '',
      'rem JVM Options',
      'set "CATALINA_OPTS=%CATALINA_OPTS% -Xms256m"',
      'set "CATALINA_OPTS=%CATALINA_OPTS% -Xmx1024m"',
      'set "CATALINA_OPTS=%CATALINA_OPTS% -Dfile.encoding=UTF-8"',
      '',
    ].join('\r\n');

    await fs.writeFile(path.join(instanceDir, 'bin', 'setenv.bat'), content);
  }
}
