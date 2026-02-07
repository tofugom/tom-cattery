import { execFile } from 'child_process';

export class MetricsCollector {

  /**
   * PID의 RSS(Resident Set Size)를 KB 단위로 반환한다.
   * macOS/Linux: ps -o rss= -p {pid}
   * Windows: wmic process where processid={pid} get WorkingSetSize
   */
  static getRssKb(pid: number): Promise<number | undefined> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile('wmic', ['process', 'where', `processid=${pid}`, 'get', 'WorkingSetSize'],
          { timeout: 3000 }, (err, stdout) => {
            if (err) { resolve(undefined); return; }
            const lines = stdout.trim().split(/\r?\n/).filter(l => l.trim());
            if (lines.length >= 2) {
              const bytes = parseInt(lines[1].trim());
              resolve(isNaN(bytes) ? undefined : Math.round(bytes / 1024));
            } else {
              resolve(undefined);
            }
          });
      } else {
        execFile('ps', ['-o', 'rss=', '-p', String(pid)],
          { timeout: 3000 }, (err, stdout) => {
            if (err) { resolve(undefined); return; }
            const kb = parseInt(stdout.trim());
            resolve(isNaN(kb) ? undefined : kb);
          });
      }
    });
  }

  /** 밀리초를 "2시간 15분" 형태로 변환 */
  static formatUptime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const parts: string[] = [];
    if (d > 0) { parts.push(`${d}일`); }
    if (h > 0) { parts.push(`${h}시간`); }
    if (m > 0) { parts.push(`${m}분`); }
    if (parts.length === 0) { parts.push(`${s}초`); }
    return parts.join(' ');
  }

  /** KB를 "123.4 MB" 형태로 변환 */
  static formatMemoryMb(rssKb: number): string {
    return `${(rssKb / 1024).toFixed(1)} MB`;
  }
}
