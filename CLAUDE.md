# CLAUDE.md - Tom Cattery Project Context

## 프로젝트 개요

**Tom Cattery**는 VSCode에서 Apache Tomcat 서버를 관리하는 Extension이다.
Eclipse의 Tomcat 서버 관리 수준의 편의성을 VSCode에서 제공하는 것이 목표.

- Extension ID: `tom-cattery`
- Display Name: `Tom Cattery`
- Description: `🐱 Tomcat Server Manager for VSCode - raise your Tomcats in one place`
- 언어: TypeScript
- 이름 유래: Tomcat(수고양이) + Cattery(고양이 사육장) — 여러 Tomcat 인스턴스를 한 곳에서 관리하는 사육장 컨셉

---

## 이 프로젝트를 만들게 된 배경

1. **Community Server Connector의 한계**: 기존에 사용하던 VSCode Extension인데, 설정이 잘 안 되고 Gradle multi-project 환경에서 여러 Tomcat 인스턴스를 구성·관리하기 어려웠음
2. **Gradle Multi-Project 환경**: 하나의 workspace에서 여러 WAR 모듈(web-app, api-server, admin-console 등)을 각각 독립된 Tomcat 인스턴스에 배포하고 동시에 기동해야 하는 요구사항
3. **Eclipse 수준의 편의성**: Eclipse에서는 Tomcat 설정, 디버그, 배포가 자연스러운데 VSCode에서는 그 수준에 미치지 못함

---

## 핵심 설계 결정 사항

### 디렉토리 구조
- CATALINA_BASE 위치: `~/.vscode/tom-cattery/servers/{server-name}/`
- Runtime 위치: `~/.vscode/tom-cattery/runtimes/{tomcat-version}/`
- 메타데이터 파일: `.tom-cattery.json` (각 서버 디렉토리 내)

### 배포 방식
- WAR 파일을 **exploded(압축 해제) 형태**로 `webapps/` 하위에 배포
- Context Path 매핑: `/` → `ROOT/`, `/api` → `api/`, `/app/v2` → `app#v2/`
- 증분 배포: CRC 비교로 변경된 파일만 덮어쓰기
- Hot Sync: JSP/HTML/CSS는 빌드 없이 즉시 복사, Java 소스는 Gradle 빌드 후 재배포
- File Watcher로 소스 변경 감지 → 자동 배포 (autoDeploy 설정 시)

### 디버그 방식
- 원클릭 디버그: Debug 버튼 → setenv.sh에 JPDA 주입 → `catalina.sh jpda run` → 포트 리스닝 감지 → `vscode.debug.startDebugging()` 자동 호출
- launch.json 불필요: 동적으로 debug configuration 생성해서 바로 attach
- Source Path 자동 감지: settings.gradle / build.gradle 파싱으로 multi-module breakpoint 자동 매핑
- Multi-Instance 동시 디버깅: 각 서버별 독립 JPDA 포트

### 커맨드 네이밍
- prefix: `tomCattery.*`
- 예: `tomCattery.addServer`, `tomCattery.startServer`, `tomCattery.debugServer`

---

## 참조 문서

이 프로젝트에는 두 개의 상세 설계 문서가 있다. 반드시 읽고 구현할 것:

1. **`tom-cattery-design.md`** — 전체 설계 문서
   - 아키텍처 (모듈 구조, 의존 관계)
   - 디렉토리 구조 및 .tom-cattery.json 스키마
   - 서버 생성/기동/중지 시퀀스 다이어그램
   - Debug 상세 설계 (DebugController 코드 스케치 포함)
   - WAR Exploded 자동 배포 상세 설계 (DeployManager 코드 스케치 포함)
   - VSCode UI 구성 (TreeView, Webview 레이아웃)
   - 핵심 TypeScript 인터페이스 (TomcatInstance, Deployment, DebugConfig 등)
   - setenv.sh 템플릿
   - package.json contributes 예시

2. **`tom-cattery-techstack-guide.md`** — 기술 스택 가이드
   - VSCode Extension API 구조 및 생명주기
   - npm 의존성 패키지 목록
   - Tom Cattery 기능 ↔ VSCode API 매핑
   - 구현 Phase별 작업 순서 및 확인 포인트

---

## 기술 스택

### 런타임 의존성
```json
{
  "fast-xml-parser": "^4.3.0",
  "adm-zip": "^0.5.10",
  "portfinder": "^1.0.32"
}
```

### 개발 의존성
```json
{
  "typescript": "^5.3.0",
  "@types/vscode": "^1.85.0",
  "@types/node": "^20.0.0",
  "@types/adm-zip": "^0.5.5",
  "@vscode/test-electron": "^2.3.0",
  "esbuild": "^0.19.0",
  "@vscode/vsce": "^2.22.0"
}
```

### Node.js 내장 모듈 (설치 불필요)
- `child_process` — Tomcat 프로세스 관리
- `fs` / `fs/promises` — 파일 시스템
- `net` — 포트 체크
- `path` — 경로 처리
- `https` — Tomcat 다운로드

---

## 구현 순서 (Phase별)

각 Phase는 F5로 동작 확인이 가능한 단위로 나뉜다.

### Phase 0: 프로젝트 셋업
- `yo code`로 TypeScript Extension 프로젝트 생성
- npm 의존성 설치
- src/ 폴더 구조 잡기:
  ```
  src/
  ├── extension.ts          # 진입점
  ├── commands/             # 커맨드 핸들러
  ├── views/                # TreeView, Webview Provider
  ├── core/                 # 비즈니스 로직
  │   ├── RuntimeManager.ts
  │   ├── InstanceManager.ts
  │   ├── ProcessManager.ts
  │   ├── DeployManager.ts
  │   ├── DebugController.ts
  │   ├── LogStreamer.ts
  │   └── ConfigParser.ts
  └── types/                # 인터페이스 정의
      └── index.ts
  ```

### Phase 1: 뼈대 (빈 UI)
- package.json의 contributes 섹션 완성 (commands, views, viewsContainers)
- extension.ts activate() 함수
- 빈 TreeView Provider 등록 → Activity Bar에 🐱 아이콘
- "Tom Cattery: New Server" 커맨드 → InputBox로 이름 입력
- **확인**: F5 → Activity Bar에 아이콘, 커맨드 팔레트에 "Tom Cattery" 검색

### Phase 2: CATALINA_BASE 생성
- RuntimeManager: 로컬 Tomcat 경로 선택 (showOpenDialog)
- InstanceManager: 디렉토리 생성 + conf 복사 + server.xml 포트 패치 + setenv.sh 생성
- TreeView에 생성된 서버 표시
- **확인**: New Server → 경로/이름/포트 입력 → `~/.vscode/tom-cattery/servers/` 확인

### Phase 3: 기동/중지
- ProcessManager: `catalina.sh run` 실행 (child_process.spawn)
- LogStreamer: stdout을 OutputChannel로 스트리밍
- TreeView 상태 반영 (🟢 Running / ⚫ Stopped)
- Start / Stop / Restart 커맨드
- **확인**: Start → Tomcat 기동 → 로그 출력 → localhost:8080 접속 → Stop

### Phase 4: WAR Exploded 배포
- DeployManager: WAR → webapps/{contextDir}/ 에 explode
- Context Path 매핑 로직
- Gradle Build Hook (Task API)
- 증분 배포 (변경 파일만)
- **확인**: Deploy → webapps/ROOT/ 에 파일 배포됨 → 브라우저 접속

### Phase 5: 원클릭 디버그
- DebugController: setenv.sh JPDA 주입 → catalina.sh jpda run → 포트 대기 → auto-attach
- Source Path 자동 감지
- Debug 세션 종료 시 정리
- **확인**: Debug → Breakpoint 설정 → 브라우저 요청 → 코드에서 멈춤

### Phase 6: 자동 배포 & 설정 UI
- FileSystemWatcher 기반 auto-deploy
- Hot Sync (JSP/HTML/CSS 즉시 복사)
- Config Webview (서버 설정 폼)
- **확인**: JSP 수정 → 자동 반영, 설정 UI에서 포트 변경

---

## 핵심 인터페이스 (src/types/index.ts)

```typescript
export interface TomcatInstance {
  name: string;
  basePath: string;          // CATALINA_BASE
  runtimePath: string;       // CATALINA_HOME
  ports: PortConfig;
  javaHome: string;
  jvmArgs: string[];
  envVars: Record<string, string>;
  deployments: Deployment[];
  debug: DebugConfig;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'debugging';
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
```

---

## 작업 규칙

### 언어 및 문서 정책
- 모든 문서, 대답, 커밋 메시지는 **한글**로 작성한다
- 문서는 **Markdown** 형식으로 작성한다
- 도식화가 필요한 경우 **Mermaid.js**를 사용한다 (flowchart, sequence, class diagram 등 적절한 방식 선택)

### 커밋 정책
- 각 Phase 구현이 완료되면 **다음 Phase로 넘어가기 전에 반드시 커밋**한다
- 커밋 메시지는 변경 내용을 명확히 요약한다

### 브랜치 전략
- 작업 브랜치: `feature/phase-1`
- 메인 브랜치: `main`

---

## 주의사항

- package.json의 `contributes` 섹션을 먼저 완성한 후 코드를 채울 것 (VSCode가 이 선언을 기반으로 Extension을 인식)
- setenv.sh의 JPDA 블록은 `# ===== TOM CATTERY DEBUG CONFIG (auto-managed) =====` 마커로 관리 (재생성 시 교체)
- Extension 번들링은 esbuild 사용 권장
- 필수 의존 Extension: `redhat.java`, `vscjava.vscode-java-debug` (없으면 안내 메시지 표시)
- Windows 지원을 고려하여 setenv.bat도 생성하고, 경로 구분자는 path.join() 사용
