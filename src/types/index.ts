export interface TomcatInstance {
  name: string;
  basePath: string;
  runtimePath: string;
  ports: PortConfig;
  javaHome: string;
  jvmArgs: string[];
  envVars: Record<string, string>;
  deployments: Deployment[];
  debug: DebugConfig;
  timeouts: TimeoutConfig;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'debugging';
  pid?: number;
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
