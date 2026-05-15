export interface TomcatInstance {
  id: string;                // CATALINA_BASE 디렉터리 키 (워크스페이스 간 충돌 방지용 불변 ID)
  name: string;
  basePath: string;          // globalStorage/servers/{id}
  runtimePath: string;
  runtimeVersion?: string;
  runtimeType?: 'local' | 'downloaded';
  ports: PortConfig;
  javaHome: string;
  javaHomeName?: string;
  jvmArgs: string[];
  envVars: Record<string, string>;
  deployments: Deployment[];
  debug: DebugConfig;
  timeouts: TimeoutConfig;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'debugging';
  pid?: number;
  startedAt?: number;  // Date.now() — 서버 기동 시각 (transient, 영속화하지 않음)
  provisioned?: boolean;  // CATALINA_BASE 디렉터리 실재 여부 (transient)
}

export interface TimeoutConfig {
  start: number;  // seconds, default 45
  stop: number;   // seconds, default 15
}

export interface PortConfig {
  http: number;
  https: number;
  shutdown: number;
  ajp: number;
  debug: number;
}

export interface Deployment {
  name: string;
  type: 'war' | 'exploded' | 'gradle';
  buildTask?: string;
  warPath: string;
  contextPath: string;
  autoDeploy: boolean;
  watchPaths?: string[];
}

export interface DebugConfig {
  enabled: boolean;
  port: number;
  suspend: boolean;
  autoAttach: boolean;
  sourcePaths: string[];
}

export interface TomcatRuntime {
  version: string;
  path: string;
  type: 'local' | 'downloaded';
  majorVersion: number;
}

export interface TomCatteryExportData {
  version: 1;
  exportedAt: string;
  servers: TomCatteryServerExport[];
}

export interface TomCatteryServerExport {
  id?: string;               // 워크스페이스 레지스트리에서는 필수, 외부 export 파일에서는 없을 수 있음
  name: string;
  runtimePath: string;
  runtimeVersion?: string;
  runtimeType?: 'local' | 'downloaded';
  javaHome: string;
  javaHomeName?: string;
  ports: PortConfig;
  jvmArgs: string[];
  envVars: Record<string, string>;
  deployments: Deployment[];
  debug: DebugConfig;
  timeouts: TimeoutConfig;
}
