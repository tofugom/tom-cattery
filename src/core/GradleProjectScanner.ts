import * as path from 'path';
import * as fs from 'fs/promises';

export interface GradleWarModule {
  name: string;         // 모듈명 (예: "web-app", 루트인 경우 rootProject.name)
  projectDir: string;   // 모듈 절대 경로
  warPath: string;      // build/libs/{name}*.war (예상 경로 또는 실제 경로)
  buildTask: string;    // ":{name}:war" / ":{name}:bootWar" (Spring Boot 적용 시)
  watchPath: string;    // src/main/webapp 절대 경로
}

const BOOT_PLUGIN_ID = 'org.springframework.boot';

export class GradleProjectScanner {

  /**
   * 워크스페이스 루트에서 Gradle 프로젝트를 스캔하여 WAR 모듈 목록을 반환한다.
   * 1. settings.gradle(.kts) 파싱 → 서브프로젝트 목록 추출
   * 2. 각 모듈의 build.gradle(.kts)에서 war 플러그인 사용 여부 확인
   *    (루트의 subprojects {} / allprojects {} 블록을 통한 적용도 감지)
   * 3. 루트 자체가 WAR 모듈일 수도 있으므로 항상 함께 검사
   * 4. WAR 모듈만 GradleWarModule 배열로 반환
   */
  async scanWorkspace(workspaceRoot: string): Promise<GradleWarModule[]> {
    const settingsFile = await this.findSettingsFile(workspaceRoot);
    const rootBuildContent = await this.readBuildFile(workspaceRoot);
    const warAppliedToChildren = rootBuildContent
      ? this.appliesPluginToChildren(rootBuildContent, 'war')
      : false;
    const bootAppliedToChildren = rootBuildContent
      ? this.appliesPluginToChildren(rootBuildContent, BOOT_PLUGIN_ID)
      : false;

    const modules: GradleWarModule[] = [];
    let rootName: string | undefined;
    let subprojects: string[] = [];

    if (settingsFile) {
      const content = await fs.readFile(settingsFile, 'utf-8');
      subprojects = this.parseIncludeStatements(content);
      rootName = this.parseRootProjectName(content);
    }

    // 루트 자체가 war 프로젝트인지 검사 (멀티 모듈 여부와 무관하게)
    const rootSelf = rootBuildContent ? this.stripChildBlocks(rootBuildContent) : '';
    const rootHasOwnWar = rootBuildContent ? this.containsWarPlugin(rootSelf) : false;
    if (rootHasOwnWar) {
      const name = rootName || path.basename(workspaceRoot);
      const rootHasOwnBoot = this.containsPlugin(rootSelf, BOOT_PLUGIN_ID);
      const task = rootHasOwnBoot ? ':bootWar' : ':war';
      modules.push(this.createWarModule(name, workspaceRoot, task, workspaceRoot));
    }

    if (subprojects.length === 0) {
      return modules;
    }

    // 멀티 모듈: 각 서브프로젝트 검사
    for (const sub of subprojects) {
      // 모듈명 (:을 /로 치환하여 디렉터리 경로 도출)
      const moduleDir = sub.replace(/:/g, '/');
      const moduleName = sub.split(':').pop()!;
      const projectDir = path.join(workspaceRoot, moduleDir);

      const subBuildContent = await this.readBuildFile(projectDir);
      const subHasOwnWar = subBuildContent ? this.containsWarPlugin(subBuildContent) : false;
      const inheritsWar = warAppliedToChildren && (await this.hasWebappLayout(projectDir));

      if (!(subHasOwnWar || inheritsWar)) {
        continue;
      }

      const subHasOwnBoot = subBuildContent ? this.containsPlugin(subBuildContent, BOOT_PLUGIN_ID) : false;
      const isBoot = subHasOwnBoot || bootAppliedToChildren;
      const task = isBoot ? `:${sub}:bootWar` : `:${sub}:war`;
      modules.push(this.createWarModule(moduleName, projectDir, task, workspaceRoot));
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

  private async readBuildFile(dir: string): Promise<string | undefined> {
    for (const name of ['build.gradle.kts', 'build.gradle']) {
      const filePath = path.join(dir, name);
      try {
        return await fs.readFile(filePath, 'utf-8');
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
   *   include 'web-app'                    (:: prefix 없는 형태)
   *   include 'a',
   *           'b'                          (다중 라인)
   */
  parseIncludeStatements(content: string): string[] {
    // 라인 주석 제거 (// 부터 줄 끝까지)
    const stripped = content
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');

    const modules: string[] = [];
    // include 키워드 다음에 연속된 quoted string 시퀀스를 모두 잡는다
    // 콤마/공백/개행으로 구분된 문자열 시퀀스를 허용
    const includeRegex = /\binclude\b\s*\(?\s*((?:['"][^'"\n]+['"]\s*,?\s*)+)/g;
    let match: RegExpExecArray | null;

    while ((match = includeRegex.exec(stripped)) !== null) {
      const args = match[1];
      const stringRegex = /['"]([^'"\n]+)['"]/g;
      let strMatch: RegExpExecArray | null;
      while ((strMatch = stringRegex.exec(args)) !== null) {
        let moduleName = strMatch[1].trim();
        if (moduleName.startsWith(':')) {
          moduleName = moduleName.slice(1);
        }
        if (moduleName) {
          modules.push(moduleName);
        }
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
   * 해당 디렉터리의 build.gradle(.kts)에 war 플러그인이 있는지 확인한다.
   * 감지 패턴:
   *   id 'war'           → Groovy
   *   id("war")          → Kotlin DSL
   *   apply plugin: 'war' → 레거시 Groovy
   */
  containsWarPlugin(content: string): boolean {
    return this.containsPlugin(content, 'war');
  }

  /**
   * 임의 플러그인 id 의 적용 여부를 검사한다. dot 포함 id 도 지원.
   *   id 'war'                          → Groovy
   *   id("org.springframework.boot")    → Kotlin DSL
   *   apply plugin: 'war'               → 레거시 Groovy
   */
  containsPlugin(content: string, pluginId: string): boolean {
    const esc = pluginId.replace(/[.+]/g, '\\$&');
    const regex = new RegExp(
      `(?:id\\s*\\(?\\s*['"]${esc}['"]\\s*\\)?|apply\\s+plugin:\\s*['"]${esc}['"])`,
    );
    return regex.test(content);
  }

  /**
   * 루트 build.gradle에서 서브프로젝트 일괄 적용 형태로 war 플러그인이 적용되는지 검사.
   * 지원 패턴:
   *   subprojects { ... }
   *   allprojects { ... }
   *   configure(subprojects) { ... }
   *   configure(subprojects.findAll { ... }) { ... }
   *   configure(subprojects.matching { ... }) { ... }
   *   configure([project(':a'), project(':b')]) { ... }
   *   configure(project(':a')) { ... }
   *
   * 단순 brace/paren 매칭 — 중첩 구조 깊이 추적.
   */
  appliesWarToChildren(content: string): boolean {
    return this.appliesPluginToChildren(content, 'war');
  }

  /**
   * 루트 build.gradle 에서 임의 플러그인 id 가 서브프로젝트 일괄 적용 형태로 적용되는지 검사.
   * `appliesWarToChildren` 의 일반화 — 'org.springframework.boot' 같은 dot id 도 지원.
   */
  appliesPluginToChildren(content: string, pluginId: string): boolean {
    // 1. subprojects {} / allprojects {} 블록
    for (const keyword of ['subprojects', 'allprojects']) {
      const regex = new RegExp(`\\b${keyword}\\b\\s*\\{`, 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const blockOpen = match.index + match[0].length - 1;
        const blockEnd = this.findMatchingBrace(content, blockOpen);
        if (blockEnd > blockOpen) {
          const block = content.slice(blockOpen + 1, blockEnd);
          if (this.containsPlugin(block, pluginId)) {
            return true;
          }
        }
      }
    }

    // 2. configure(...) {} 블록 — 인자가 자식 프로젝트 컬렉션을 가리키는 경우만
    const configureRegex = /\bconfigure\s*\(/g;
    let cfgMatch: RegExpExecArray | null;
    while ((cfgMatch = configureRegex.exec(content)) !== null) {
      const parenOpen = cfgMatch.index + cfgMatch[0].length - 1;
      const parenEnd = this.findMatchingParen(content, parenOpen);
      if (parenEnd === -1) {
        continue;
      }

      const args = content.slice(parenOpen + 1, parenEnd);
      if (!/\bsubprojects\b|\bproject\s*\(/.test(args)) {
        continue;
      }

      const rest = content.slice(parenEnd + 1);
      if (!/^\s*\{/.test(rest)) {
        continue;
      }
      const blockOpen = parenEnd + 1 + rest.indexOf('{');
      const blockEnd = this.findMatchingBrace(content, blockOpen);
      if (blockEnd > blockOpen) {
        const block = content.slice(blockOpen + 1, blockEnd);
        if (this.containsPlugin(block, pluginId)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * openIndex 위치의 '(' 와 짝이 맞는 ')' 의 인덱스를 반환. 못 찾으면 -1.
   * 단순 depth count — 문자열 안 괄호는 무시하지 않음 (대부분의 build.gradle 에서 문제 없음).
   */
  private findMatchingParen(content: string, openIndex: number): number {
    if (content[openIndex] !== '(') {
      return -1;
    }
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  /**
   * 루트 build.gradle 본문에서 자식용 블록을 제거한 결과를 반환.
   * 제거 대상:
   *   subprojects {}, allprojects {}
   *   configure(subprojects...) {}, configure(project(...)) {}
   * 루트 "자체"의 플러그인 적용을 검사할 때 사용.
   */
  private stripChildBlocks(content: string): string {
    let result = content;

    // 1. subprojects / allprojects
    for (const keyword of ['subprojects', 'allprojects']) {
      const regex = new RegExp(`\\b${keyword}\\b\\s*\\{`, 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(result)) !== null) {
        const blockOpen = match.index + match[0].length - 1;
        const blockEnd = this.findMatchingBrace(result, blockOpen);
        if (blockEnd > blockOpen) {
          result = result.slice(0, match.index) + result.slice(blockEnd + 1);
          regex.lastIndex = match.index;
        }
      }
    }

    // 2. configure(...) {} — 인자가 자식 프로젝트 컬렉션을 가리키는 경우만
    const configureRegex = /\bconfigure\s*\(/g;
    let cfgMatch: RegExpExecArray | null;
    while ((cfgMatch = configureRegex.exec(result)) !== null) {
      const parenOpen = cfgMatch.index + cfgMatch[0].length - 1;
      const parenEnd = this.findMatchingParen(result, parenOpen);
      if (parenEnd === -1) {
        continue;
      }
      const args = result.slice(parenOpen + 1, parenEnd);
      if (!/\bsubprojects\b|\bproject\s*\(/.test(args)) {
        continue;
      }
      const rest = result.slice(parenEnd + 1);
      if (!/^\s*\{/.test(rest)) {
        continue;
      }
      const blockOpen = parenEnd + 1 + rest.indexOf('{');
      const blockEnd = this.findMatchingBrace(result, blockOpen);
      if (blockEnd > blockOpen) {
        result = result.slice(0, cfgMatch.index) + result.slice(blockEnd + 1);
        configureRegex.lastIndex = cfgMatch.index;
      }
    }

    return result;
  }

  /**
   * openIndex 위치의 '{' 와 짝이 맞는 '}' 의 인덱스를 반환. 못 찾으면 -1.
   */
  private findMatchingBrace(content: string, openIndex: number): number {
    if (content[openIndex] !== '{') {
      return -1;
    }
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  /**
   * src/main/webapp 디렉터리가 있으면 WAR 모듈로 추정 가능.
   */
  private async hasWebappLayout(projectDir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(projectDir, 'src', 'main', 'webapp'));
      return stat.isDirectory();
    } catch {
      return false;
    }
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
