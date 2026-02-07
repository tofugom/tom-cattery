import * as net from 'net';
import { PortConfig, TomcatInstance } from '../types';

export class PortUtils {
  /**
   * 다른 서버 인스턴스와 포트 충돌 검사.
   * 충돌 발견 시 메시지 반환, 없으면 null.
   */
  static findConflict(
    ports: PortConfig,
    instances: TomcatInstance[],
    excludeName?: string,
  ): string | null {
    const portEntries: [string, number][] = [
      ['HTTP', ports.http],
      ['HTTPS', ports.https],
      ['Shutdown', ports.shutdown],
      ['AJP', ports.ajp],
      ['Debug', ports.debug],
    ];

    for (const [label, port] of portEntries) {
      for (const inst of instances) {
        if (excludeName && inst.name === excludeName) {
          continue;
        }
        const instPorts: [string, number][] = [
          ['HTTP', inst.ports.http],
          ['HTTPS', inst.ports.https],
          ['Shutdown', inst.ports.shutdown],
          ['AJP', inst.ports.ajp],
          ['Debug', inst.ports.debug],
        ];
        for (const [instLabel, instPort] of instPorts) {
          if (port === instPort) {
            return `${label} 포트 ${port}이 서버 "${inst.name}"의 ${instLabel} 포트와 충돌합니다.`;
          }
        }
      }
    }

    return null;
  }

  /**
   * OS 레벨 포트 사용 여부 체크 (TCP connect 시도).
   */
  static isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => {
        server.close(() => resolve(false));
      });
      server.listen(port, 'localhost');
    });
  }

  /**
   * 기본 HTTP 포트에서 시작하여 충돌 없는 포트 세트 자동 할당.
   * 10씩 증가하며 서버 간 충돌 + OS 충돌 모두 체크.
   */
  static async findAvailablePorts(
    baseHttpPort: number,
    instances: TomcatInstance[],
  ): Promise<PortConfig> {
    for (let offset = 0; offset < 100; offset++) {
      const httpPort = baseHttpPort + offset;
      const ports: PortConfig = {
        http: httpPort,
        https: httpPort + 363,
        shutdown: httpPort - 75,
        ajp: httpPort - 71,
        debug: httpPort - 80,
      };

      // 다른 서버와 충돌 체크
      if (PortUtils.findConflict(ports, instances)) {
        continue;
      }

      // OS 레벨 HTTP 포트 사용 여부 (핵심 포트만 체크)
      const httpInUse = await PortUtils.isPortInUse(ports.http);
      if (httpInUse) {
        continue;
      }

      return ports;
    }

    // 100번 시도 후에도 못 찾으면 기본값 반환
    return {
      http: baseHttpPort,
      https: baseHttpPort + 363,
      shutdown: baseHttpPort - 75,
      ajp: baseHttpPort - 71,
      debug: baseHttpPort - 80,
    };
  }

  /**
   * HTTP 포트 기준으로 파생 포트 세트 생성.
   */
  static derivePorts(httpPort: number): PortConfig {
    return {
      http: httpPort,
      https: httpPort + 363,
      shutdown: httpPort - 75,
      ajp: httpPort - 71,
      debug: httpPort - 80,
    };
  }
}
