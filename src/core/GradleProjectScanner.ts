import * as path from 'path';
import * as fs from 'fs/promises';

export interface GradleWarModule {
  name: string;         // 모듈명 (예: "web-app", 루트인 경우 rootProject.name)
  projectDir: string;   // 모듈 절대 경로
  warPath: string;      // build/libs/{name}*.war (예상 경로 또는 실제 경로)
  buildTask: string;    // ":{name}:war" 또는 루트면 ":war"
  watchPath: string;    // src/main/webapp 절대 경로
}

export class GradleProjectScanner {

  /**
   * 워크스페이스 루트에서 Gradle 프로젝트를 스캔하여 WAR 모듈 목록을 반환한다.
   * 1. settings.gradle(.kts) 파싱 → 서브프로젝트 목록 추출
   * 2. 각 모듈의 build.gradle(.kts)에서 war 플러그인 사용 여부 확인
   * 3. WAR 모듈만 GradleWarModule 배열로 반환
   */
  async scanWorkspace(workspaceRoot: string): Promise<GradleWarModule[]> {
    const settingsFile = await this.findSettingsFile(workspaceRoot);
    if (!settingsFile) {
      // settings.gradle 없으면 루트 프로젝트만 검사
      return this.checkRootProject(workspaceRoot);
    }

    const content = await fs.readFile(settingsFile, 'utf-8');
    const subprojects = this.parseIncludeStatements(content);
    const rootName = this.parseRootProjectName(content);

    if (subprojects.length === 0) {
      // include 없음 → 단일 모듈 프로젝트
      return this.checkRootProject(workspaceRoot, rootName);
    }

    // 멀티 모듈: 각 서브프로젝트 검사
    const modules: GradleWarModule[] = [];

    for (const sub of subprojects) {
      // 모듈명 (:을 /로 치환하여 디렉터리 경로 도출)
      const moduleDir = sub.replace(/:/g, '/');
      const moduleName = sub.split(':').pop()!;
      const projectDir = path.join(workspaceRoot, moduleDir);

      if (await this.hasWarPlugin(projectDir)) {
        modules.push(this.createWarModule(moduleName, projectDir, `:${sub}:war`, workspaceRoot));
      }
    }

    return modules;
  }

  private async findSettingsFile(dir: string): Promise<string | undefined> {
    for (const name of ['settings.gradle.kts', 'settings.gradle']) {
      const filePath = path.join(dir, name);
      try {
        await fs.access(filePath);
        return filePath;
      } catch {
        // 파일 없음
      }
    }
    return undefined;
  }

  /**
   * settings.gradle의 include 문에서 서브프로젝트 목록을 파싱한다.
   * 지원 패턴:
   *   include ':web-app', ':api-server'
   *   include ':shared:common'
   *   include(":web-app")
   */
  parseIncludeStatements(content: string): string[] {
    const modules: string[] = [];
    // 모든 include 구문에서 ':module-name' 패턴을 추출
    const includeRegex = /include\s*\(?\s*([^)\n]+)/g;
    let match;

    while ((match = includeRegex.exec(content)) !== null) {
      const args = match[1];
      // 따옴표 안의 :module 패턴 추출
      const moduleRegex = /['"]:([\w\-:.]+)['"]/g;
      let moduleMatch;
      while ((moduleMatch = moduleRegex.exec(args)) !== null) {
        modules.push(moduleMatch[1]);
      }
    }

    return modules;
  }

  /**
   * settings.gradle에서 rootProject.name을 파싱한다.
   */
  private parseRootProjectName(content: string): string | undefined {
    // rootProject.name = 'sample-webapp'  또는  rootProject.name = "sample-webapp"
    const match = content.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
    return match?.[1];
  }

  /**
   * 루트 프로젝트만 WAR 플러그인 여부를 검사한다.
   */
  private async checkRootProject(workspaceRoot: string, rootName?: string): Promise<GradleWarModule[]> {
    if (await this.hasWarPlugin(workspaceRoot)) {
      const name = rootName || path.basename(workspaceRoot);
      return [this.createWarModule(name, workspaceRoot, ':war', workspaceRoot)];
    }
    return [];
  }

  /**
   * 해당 디렉터리의 build.gradle(.kts)에 war 플러그인이 있는지 확인한다.
   * 감지 패턴:
   *   id 'war'           → Groovy
   *   id("war")          → Kotlin DSL
   *   apply plugin: 'war' → 레거시 Groovy
   */
  private async hasWarPlugin(projectDir: string): Promise<boolean> {
    for (const name of ['build.gradle.kts', 'build.gradle']) {
      const filePath = path.join(projectDir, name);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        if (this.containsWarPlugin(content)) {
          return true;
        }
      } catch {
        // 파일 없음
      }
    }
    return false;
  }

  containsWarPlugin(content: string): boolean {
    return /(?:id\s*\(?\s*['"]war['"]\s*\)?|apply\s+plugin:\s*['"]war['"])/.test(content);
  }

  private createWarModule(
    name: string,
    projectDir: string,
    buildTask: string,
    workspaceRoot: string,
  ): GradleWarModule {
    const relativeDir = path.relative(workspaceRoot, projectDir);
    const warPathPrefix = relativeDir
      ? `\${workspaceFolder}/${relativeDir}/build/libs`
      : '${workspaceFolder}/build/libs';

    return {
      name,
      projectDir,
      warPath: `${warPathPrefix}/*.war`,
      buildTask,
      watchPath: path.join(projectDir, 'src', 'main', 'webapp'),
    };
  }
}
