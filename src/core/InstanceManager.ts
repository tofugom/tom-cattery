import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  TomcatInstance,
  TomcatRuntime,
  PortConfig,
  Deployment,
  TomCatteryExportData,
  TomCatteryServerExport,
} from '../types';
import { ConfigParser } from './ConfigParser';

/**
 * 서버는 워크스페이스별로 관리된다.
 * - 진실의 원천(source of truth): 워크스페이스의 `.vscode/tom-cattery.json` 레지스트리
 * - CATALINA_BASE 실체: `globalStorage/servers/{id}/` — 이름이 아닌 불변 ID로 키잉하여
 *   워크스페이스 간 동일 이름 충돌을 방지한다 (Eclipse의 `.metadata/.../tmp0` 방식 차용)
 * - CATALINA_BASE는 lazy provisioning: 레지스트리에는 있으나 디렉터리가 없으면
 *   기동 시점(ensureBase)에 정의로부터 재생성한다
 */
export class InstanceManager {
  readonly baseDir: string;
  /** 현재 워크스페이스의 `.vscode/tom-cattery.json` 절대경로 (워크스페이스 없으면 undefined) */
  readonly registryPath: string | undefined;
  /** 워크스페이스 루트 경로 (base 소유권 충돌 감지에 사용) */
  private readonly workspacePath: string | undefined;
  private instances: TomcatInstance[] = [];

  constructor(globalStoragePath: string, registryPath?: string) {
    this.baseDir = path.join(globalStoragePath, 'servers');
    this.registryPath = registryPath;
    this.workspacePath = registryPath
      ? path.dirname(path.dirname(registryPath))
      : undefined;
  }

  /**
   * 워크스페이스 레지스트리에서 서버 목록을 로드한다.
   * 워크스페이스가 없으면 빈 목록을 반환한다.
   */
  async loadInstances(): Promise<TomcatInstance[]> {
    this.instances = [];
    if (!this.registryPath) {
      return [];
    }

    const registry = await this.readRegistry();
    let mutated = false;

    for (const s of registry.servers) {
      let id = s.id;
      if (!id) {
        id = randomUUID();
        s.id = id;
        mutated = true;
      }
      const basePath = path.join(this.baseDir, id);

      let provisioned = false;
      try {
        await fs.access(path.join(basePath, '.tom-cattery.json'));
        provisioned = true;
      } catch {
        // CATALINA_BASE 미생성 — 기동 시 ensureBase가 생성
      }

      this.instances.push({
        id,
        name: s.name,
        basePath,
        runtimePath: s.runtimePath,
        runtimeVersion: s.runtimeVersion,
        runtimeType: s.runtimeType,
        ports: { ...s.ports },
        javaHome: s.javaHome || '',
        javaHomeName: s.javaHomeName || undefined,
        jvmArgs: s.jvmArgs || [],
        envVars: s.envVars || {},
        deployments: s.deployments || [],
        debug: s.debug || {
          enabled: true,
          port: s.ports.debug,
          suspend: false,
          autoAttach: true,
          sourcePaths: [],
        },
        timeouts: s.timeouts || { start: 45, stop: 15 },
        status: 'stopped',
        provisioned,
      });
    }

    if (mutated) {
      await this.saveRegistry();
    }

    return this.instances;
  }

  getInstances(): TomcatInstance[] {
    return [...this.instances];
  }

  getInstance(name: string): TomcatInstance | undefined {
    return this.instances.find(i => i.name === name);
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

  // ── 레지스트리 (.vscode/tom-cattery.json) ────────────────────────────────

  private async readRegistry(): Promise<TomCatteryExportData> {
    const empty: TomCatteryExportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      servers: [],
    };
    if (!this.registryPath) {
      return empty;
    }
    try {
      const content = await fs.readFile(this.registryPath, 'utf-8');
      const data = JSON.parse(content) as TomCatteryExportData;
      if (!data.version || !Array.isArray(data.servers)) {
        return empty;
      }
      return data;
    } catch {
      return empty;
    }
  }

  private toExport(inst: TomcatInstance): TomCatteryServerExport {
    return {
      id: inst.id,
      name: inst.name,
      runtimePath: inst.runtimePath,
      runtimeVersion: inst.runtimeVersion,
      runtimeType: inst.runtimeType,
      javaHome: inst.javaHome,
      javaHomeName: inst.javaHomeName,
      ports: { ...inst.ports },
      jvmArgs: [...inst.jvmArgs],
      envVars: { ...inst.envVars },
      deployments: inst.deployments.map(d => ({ ...d })),
      debug: { ...inst.debug },
      timeouts: { ...inst.timeouts },
    };
  }

  /** 현재 인메모리 인스턴스 목록을 워크스페이스 레지스트리에 기록한다. */
  async saveRegistry(): Promise<void> {
    if (!this.registryPath) {
      return;
    }
    const data: TomCatteryExportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      servers: this.instances.map(i => this.toExport(i)),
    };
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** base 메타 + 레지스트리를 함께 갱신한다 (base 미생성 시 레지스트리만). */
  private async persist(instance: TomcatInstance): Promise<void> {
    if (instance.provisioned) {
      try {
        await this.writeBaseMeta(instance);
      } catch {
        // base 디렉터리가 아직 없으면 레지스트리만 갱신
      }
    }
    await this.saveRegistry();
  }

  // ── CATALINA_BASE 생성 / 보장 ─────────────────────────────────────────────

  async createInstance(
    name: string,
    runtime: TomcatRuntime,
    ports: PortConfig,
    javaHome: string,
    javaHomeName?: string,
  ): Promise<TomcatInstance> {
    if (!this.registryPath) {
      throw new Error('워크스페이스가 열려 있지 않아 서버를 생성할 수 없습니다.');
    }

    const id = randomUUID();
    const instance: TomcatInstance = {
      id,
      name,
      basePath: path.join(this.baseDir, id),
      runtimePath: runtime.path,
      runtimeVersion: runtime.version,
      runtimeType: runtime.type,
      ports,
      javaHome,
      javaHomeName,
      jvmArgs: [],
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
      status: 'stopped',
      provisioned: false,
    };

    await this.provision(instance);
    this.instances.push(instance);
    await this.saveRegistry();
    return instance;
  }

  /**
   * CATALINA_BASE 디렉터리가 존재하도록 보장한다 (멱등).
   * - 이미 있고 현재 워크스페이스 소유면: no-op
   * - 있으나 다른 워크스페이스 소유면(레지스트리 복붙 등): 새 id를 발급해 분리 생성
   * - 없으면: 인스턴스 정의로부터 신규 생성
   */
  async ensureBase(instance: TomcatInstance): Promise<void> {
    const metaPath = path.join(instance.basePath, '.tom-cattery.json');

    let exists = false;
    try {
      await fs.access(metaPath);
      exists = true;
    } catch {
      // base 미생성
    }

    if (exists) {
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
        const origin = meta.origin;
        if (origin && this.workspacePath && origin.workspace !== this.workspacePath) {
          // 같은 id가 다른 워크스페이스의 base를 가리킴 → 새 id로 분리
          instance.id = randomUUID();
          instance.basePath = path.join(this.baseDir, instance.id);
          await this.provision(instance);
          await this.saveRegistry();
          return;
        }
      } catch {
        // 메타 파싱 실패 시 그대로 사용
      }
      instance.provisioned = true;
      return;
    }

    await this.provision(instance);
    await this.saveRegistry();
  }

  /** 인스턴스 정의로부터 CATALINA_BASE 디렉터리 일체를 생성한다. */
  private async provision(instance: TomcatInstance): Promise<void> {
    if (!(await this.isRuntimeValid(instance.runtimePath))) {
      throw new Error(
        `Tomcat Runtime 경로가 유효하지 않습니다: ${instance.runtimePath}\n` +
        'Runtime을 다시 등록한 뒤 서버 설정을 갱신하세요.',
      );
    }

    const instanceDir = instance.basePath;
    const dirs = ['conf', 'bin', 'webapps', 'logs', 'work', 'temp'];
    for (const dir of dirs) {
      await fs.mkdir(path.join(instanceDir, dir), { recursive: true });
    }

    await this.copyDir(
      path.join(instance.runtimePath, 'conf'),
      path.join(instanceDir, 'conf'),
    );

    await ConfigParser.patchServerXmlPorts(
      path.join(instanceDir, 'conf', 'server.xml'),
      instance.ports,
    );
    await ConfigParser.patchContextXml(
      path.join(instanceDir, 'conf', 'context.xml'),
    );

    await this.regenerateSetenvSh(instance);
    await this.regenerateSetenvBat(instance);
    await this.writeBaseMeta(instance);

    instance.provisioned = true;
  }

  private async isRuntimeValid(runtimePath: string): Promise<boolean> {
    try {
      await fs.access(path.join(runtimePath, 'conf', 'server.xml'));
      return true;
    } catch {
      return false;
    }
  }

  /** CATALINA_BASE 내 `.tom-cattery.json` 메타를 인스턴스 현재 상태로 기록한다. */
  private async writeBaseMeta(instance: TomcatInstance): Promise<void> {
    const metadata = {
      id: instance.id,
      name: instance.name,
      // 소유권 표식 — 같은 id가 다른 워크스페이스에서 재사용될 때 충돌 감지용
      origin: { workspace: this.workspacePath || '', name: instance.name },
      runtimePath: instance.runtimePath,
      runtimeVersion: instance.runtimeVersion,
      runtimeType: instance.runtimeType,
      httpPort: instance.ports.http,
      httpsPort: instance.ports.https,
      shutdownPort: instance.ports.shutdown,
      ajpPort: instance.ports.ajp,
      debugPort: instance.ports.debug,
      javaHome: instance.javaHome,
      javaHomeName: instance.javaHomeName || undefined,
      jvmArgs: instance.jvmArgs.join(' '),
      envVars: instance.envVars,
      deployments: instance.deployments,
      debug: instance.debug,
      timeouts: instance.timeouts,
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(instance.basePath, '.tom-cattery.json'),
      JSON.stringify(metadata, null, 2),
      'utf-8',
    );
  }

  // ── 배포 ─────────────────────────────────────────────────────────────────

  async addDeployment(serverName: string, deployment: Deployment): Promise<void> {
    const instance = this.instances.find(i => i.name === serverName);
    if (!instance) {
      throw new Error(`Server "${serverName}" not found`);
    }

    instance.deployments = instance.deployments.filter(
      d => d.contextPath !== deployment.contextPath,
    );
    instance.deployments.push(deployment);

    await this.persist(instance);
  }

  async removeDeployment(serverName: string, contextPath: string): Promise<void> {
    const instance = this.instances.find(i => i.name === serverName);
    if (!instance) {
      return;
    }
    instance.deployments = instance.deployments.filter(d => d.contextPath !== contextPath);
    await this.persist(instance);
  }

  /**
   * 전체 설정 저장: CATALINA_BASE를 보장한 뒤 .tom-cattery.json / server.xml 포트 /
   * setenv.sh/bat / 워크스페이스 레지스트리를 모두 갱신한다.
   * 호출 시점에 instance는 이미 새 값으로 변경된 상태이며, 반환되는 oldPorts는
   * 디스크에 기록돼 있던 이전 포트 값이다.
   */
  async saveFullConfig(instance: TomcatInstance): Promise<{ oldPorts: PortConfig }> {
    await this.ensureBase(instance);

    const metaPath = path.join(instance.basePath, '.tom-cattery.json');
    let oldPorts: PortConfig = { ...instance.ports };
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      oldPorts = {
        http: meta.httpPort,
        https: meta.httpsPort,
        shutdown: meta.shutdownPort,
        ajp: meta.ajpPort,
        debug: meta.debugPort,
      };
    } catch {
      // 메타를 못 읽으면 변경 없음으로 간주
    }

    await this.writeBaseMeta(instance);

    const portsChanged = Object.keys(oldPorts).some(
      k => oldPorts[k as keyof PortConfig] !== instance.ports[k as keyof PortConfig],
    );
    if (portsChanged) {
      const serverXmlPath = path.join(instance.basePath, 'conf', 'server.xml');
      await ConfigParser.updateServerXmlPorts(serverXmlPath, oldPorts, instance.ports);
    }

    await this.regenerateSetenvSh(instance);
    await this.regenerateSetenvBat(instance);
    await this.saveRegistry();

    return { oldPorts };
  }

  async cloneInstance(
    sourceName: string,
    newName: string,
    newPorts: PortConfig,
  ): Promise<TomcatInstance> {
    const source = this.instances.find(i => i.name === sourceName);
    if (!source) {
      throw new Error(`소스 서버 "${sourceName}"을 찾을 수 없습니다.`);
    }

    // 소스 CATALINA_BASE가 없으면 먼저 생성
    await this.ensureBase(source);

    const newId = randomUUID();
    const newDir = path.join(this.baseDir, newId);

    // 1. 전체 디렉토리 복사
    await this.copyDir(source.basePath, newDir);

    // 2. webapps, logs, work, temp 클린업 (배포/캐시는 복제하지 않음)
    for (const dir of ['webapps', 'logs', 'work', 'temp']) {
      const dirPath = path.join(newDir, dir);
      await fs.rm(dirPath, { recursive: true, force: true });
      await fs.mkdir(dirPath, { recursive: true });
    }

    // 3. server.xml 포트 패치 (소스 포트 → 새 포트)
    const serverXmlPath = path.join(newDir, 'conf', 'server.xml');
    await ConfigParser.updateServerXmlPorts(serverXmlPath, source.ports, newPorts);

    // 4. 새 인스턴스 구성
    const newInstance: TomcatInstance = {
      id: newId,
      name: newName,
      basePath: newDir,
      runtimePath: source.runtimePath,
      runtimeVersion: source.runtimeVersion,
      runtimeType: source.runtimeType,
      ports: newPorts,
      javaHome: source.javaHome,
      javaHomeName: source.javaHomeName,
      jvmArgs: [...source.jvmArgs],
      envVars: { ...source.envVars },
      deployments: [], // 배포 설정은 초기화
      debug: { ...source.debug, port: newPorts.debug },
      timeouts: { ...source.timeouts },
      status: 'stopped',
      provisioned: true,
    };

    // 5. setenv.sh/bat 재생성 + 메타 기록
    await this.regenerateSetenvSh(newInstance);
    await this.regenerateSetenvBat(newInstance);
    await this.writeBaseMeta(newInstance);

    this.instances.push(newInstance);
    await this.saveRegistry();
    return newInstance;
  }

  async deleteInstance(name: string): Promise<void> {
    const instance = this.instances.find(i => i.name === name);
    this.instances = this.instances.filter(i => i.name !== name);
    if (instance) {
      await fs.rm(instance.basePath, { recursive: true, force: true });
    }
    await this.saveRegistry();
  }

  // ── setenv.sh / setenv.bat ────────────────────────────────────────────────

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
        const header = content.split('\n').filter(l =>
          l.startsWith('#!/bin/bash') || l.startsWith('# Generated by Tom Cattery'),
        ).join('\n');
        content = header + '\n\n' + block + '\n';
      }
      await fs.writeFile(shPath, content, { mode: 0o755 });
    } catch {
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

  // ── JPDA (디버그) ─────────────────────────────────────────────────────────

  private static readonly JPDA_MARKER_START = '# ===== TOM CATTERY DEBUG CONFIG (auto-managed) =====';
  private static readonly JPDA_MARKER_END = '# ===== END TOM CATTERY DEBUG CONFIG =====';
  private static readonly JPDA_MARKER_REGEX = /# ===== TOM CATTERY DEBUG CONFIG.*?# ===== END TOM CATTERY DEBUG CONFIG =====/s;

  private static readonly JPDA_BAT_MARKER_START = 'rem ===== TOM CATTERY DEBUG CONFIG (auto-managed) =====';
  private static readonly JPDA_BAT_MARKER_END = 'rem ===== END TOM CATTERY DEBUG CONFIG =====';
  private static readonly JPDA_BAT_MARKER_REGEX = /rem ===== TOM CATTERY DEBUG CONFIG.*?rem ===== END TOM CATTERY DEBUG CONFIG =====/s;

  async injectJpdaConfig(instance: TomcatInstance, debugPort: number, suspend: boolean): Promise<void> {
    await this.ensureBase(instance);

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

  // ── 유틸 ─────────────────────────────────────────────────────────────────

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
}
