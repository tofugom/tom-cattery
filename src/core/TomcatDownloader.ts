import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import AdmZip from 'adm-zip';

export interface TomcatVersionInfo {
  version: string;       // "11.0.18"
  majorVersion: number;  // 11
  downloadUrl: string;
}

export type ProgressCallback = (downloaded: number, total: number) => void;

export class TomcatDownloader {
  static readonly MIRROR_BASE = 'https://dlcdn.apache.org/tomcat';
  static readonly SUPPORTED_MAJORS = [9, 10, 11];

  readonly runtimesDir: string;

  constructor(runtimesDir: string) {
    this.runtimesDir = runtimesDir;
  }

  /** Apache CDN 디렉터리 리스팅에서 버전 목록 파싱 */
  async fetchAvailableVersions(majorVersion: number): Promise<TomcatVersionInfo[]> {
    const url = `${TomcatDownloader.MIRROR_BASE}/tomcat-${majorVersion}/`;
    const html = await this.httpGet(url);

    // 디렉터리 리스팅에서 v{x.y.z}/ 형태 추출
    const versionRegex = /href="v(\d+\.\d+\.\d+)\/"/g;
    const versions: TomcatVersionInfo[] = [];
    let match: RegExpExecArray | null;

    while ((match = versionRegex.exec(html)) !== null) {
      const version = match[1];
      versions.push({
        version,
        majorVersion,
        downloadUrl: `${url}v${version}/bin/apache-tomcat-${version}.zip`,
      });
    }

    // 최신 버전 먼저 (내림차순 정렬)
    versions.sort((a, b) => this.compareVersions(b.version, a.version));
    return versions;
  }

  /** zip 다운로드 → 압축 해제 → bin/*.sh chmod 755 */
  async download(versionInfo: TomcatVersionInfo, onProgress?: ProgressCallback): Promise<string> {
    await fsPromises.mkdir(this.runtimesDir, { recursive: true });

    const expectedDir = path.join(this.runtimesDir, `apache-tomcat-${versionInfo.version}`);

    // 이미 다운로드된 버전은 스킵
    try {
      await fsPromises.access(path.join(expectedDir, 'lib', 'catalina.jar'));
      return expectedDir;
    } catch {
      // 아직 없으므로 다운로드 진행
    }

    const zipFileName = `apache-tomcat-${versionInfo.version}.zip`;
    const tempPath = path.join(this.runtimesDir, zipFileName + '.downloading');
    const zipPath = path.join(this.runtimesDir, zipFileName);

    try {
      // 1. zip 다운로드
      await this.downloadFile(versionInfo.downloadUrl, tempPath, onProgress);
      await fsPromises.rename(tempPath, zipPath);

      // 2. 압축 해제
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(this.runtimesDir, true);

      // 3. macOS/Linux에서 bin/*.sh에 실행 권한 부여
      if (process.platform !== 'win32') {
        await this.makeExecutable(path.join(expectedDir, 'bin'));
      }

      return expectedDir;
    } finally {
      // 임시 파일/zip 정리
      try { await fsPromises.unlink(tempPath); } catch { /* ignore */ }
      try { await fsPromises.unlink(zipPath); } catch { /* ignore */ }
    }
  }

  /** 리다이렉트 처리 포함 HTTPS GET (텍스트) */
  private httpGet(url: string, maxRedirects = 5): Promise<string> {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        return reject(new Error('리다이렉트 횟수 초과'));
      }

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: 15000 }, (res) => {
        // 리다이렉트 처리
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          this.httpGet(redirectUrl, maxRedirects - 1).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('요청 시간 초과')); });
    });
  }

  /** 리다이렉트 처리 포함 파일 다운로드 (스트리밍) */
  private downloadFile(url: string, destPath: string, onProgress?: ProgressCallback, maxRedirects = 5): Promise<void> {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        return reject(new Error('리다이렉트 횟수 초과'));
      }

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: 60000 }, (res) => {
        // 리다이렉트 처리
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          this.downloadFile(redirectUrl, destPath, onProgress, maxRedirects - 1).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`다운로드 실패 — HTTP ${res.statusCode}: ${url}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        const fileStream = fs.createWriteStream(destPath);
        res.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (onProgress && totalBytes > 0) {
            onProgress(downloadedBytes, totalBytes);
          }
        });

        res.pipe(fileStream);
        fileStream.on('finish', () => { fileStream.close(); resolve(); });
        fileStream.on('error', (err) => {
          fileStream.close();
          fsPromises.unlink(destPath).catch(() => {});
          reject(err);
        });
        res.on('error', (err) => {
          fileStream.close();
          fsPromises.unlink(destPath).catch(() => {});
          reject(err);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('다운로드 시간 초과')); });
    });
  }

  /** macOS/Linux에서 bin/*.sh에 실행 권한 부여 */
  private async makeExecutable(binDir: string): Promise<void> {
    try {
      const files = await fsPromises.readdir(binDir);
      for (const file of files) {
        if (file.endsWith('.sh')) {
          await fsPromises.chmod(path.join(binDir, file), 0o755);
        }
      }
    } catch {
      // bin 디렉터리가 없거나 chmod 실패 시 무시
    }
  }

  /** 시맨틱 버전 비교: a > b → 양수, a < b → 음수, 같으면 0 */
  private compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na !== nb) { return na - nb; }
    }
    return 0;
  }
}
