# Tom Cattery - Work Log

## Phase 0 + Phase 1: 프로젝트 셋업 + 빈 UI (완료)

**작업일**: 2026-02-07
**브랜치**: feature/phase-1

### 완료 항목
- package.json 생성 (contributes 전체 선언: viewsContainers, views, commands, menus)
- tsconfig.json, .vscode/launch.json, .vscode/tasks.json 설정
- resources/tom-cattery.svg Activity Bar 아이콘
- src/types/index.ts 인터페이스 정의 (TomcatInstance, PortConfig, Deployment, DebugConfig, TomcatRuntime)
- src/views/ServerTreeProvider.ts 빈 TreeView Provider
- src/commands/serverCommands.ts 11개 커맨드 스텁 등록
- src/extension.ts 진입점 (activate/deactivate)
- npm install & compile 성공

### F5 확인
- Activity Bar에 고양이 아이콘 표시
- 빈 "Servers" TreeView
- Cmd+Shift+P → "Tom Cattery" 커맨드 검색 가능
- "New Server" → InputBox 동작

---

## Phase 2: CATALINA_BASE 생성 (완료)

**작업일**: 2026-02-07
**브랜치**: feature/phase-1

### 완료 항목
- src/core/RuntimeManager.ts — Tomcat 런타임 경로 선택, lib/catalina.jar 검증, 버전 감지, globalState 저장
- src/core/ConfigParser.ts — server.xml 포트 패치, context.xml reloadable=true 설정
- src/core/InstanceManager.ts — CATALINA_BASE 디렉토리 생성, conf 복사, setenv.sh/bat 생성, .tom-cattery.json 메타데이터
- serverCommands.ts에 addServer 전체 플로우 (런타임 선택 → 이름 → 포트 → JAVA_HOME → 생성)
- deleteServer 실제 삭제 구현
- extension.ts에서 매니저 초기화, 기존 서버 자동 로드
- package.json에 viewsWelcome 추가 (빈 상태 안내)

### 버그 수정
- TreeView description에 `$(circle-outline)` 텍스트가 그대로 출력되는 문제 → ThemeIcon 사용으로 변경
- 마우스 오버 시 Markdown 툴팁으로 포트 정보 표시

### F5 확인
- "New Server" → Tomcat 경로 선택 → 서버명/포트 입력 → `~/.vscode/tom-cattery/servers/` 에 디렉토리 생성
- TreeView에 서버 표시 (아이콘 + 이름 + 포트)
- Delete Server 동작 확인

### 메모
- 사용자 요구: 서버 생성 시 입력값(포트, JAVA_HOME 등)을 나중에 설정 패널에서 변경 가능하도록 → Phase 6(Config Webview)에서 구현 예정

---

## Phase 3: 기동/중지 (완료)

**작업일**: 2026-02-07
**브랜치**: feature/phase-1

### 완료 항목
- src/core/ProcessManager.ts
  - `catalina.sh run` (spawn)으로 Tomcat 기동, CATALINA_HOME/BASE/JAVA_HOME 환경변수 설정
  - `catalina.sh stop`으로 graceful shutdown (15초 타임아웃 후 SIGKILL)
  - Restart = Stop + Start
  - stdout에서 "Server startup in" 감지 시 starting → running 상태 전환
  - 프로세스 비정상 종료 시 경고 메시지
  - killAll() — deactivate 시 모든 프로세스 강제 종료
  - Windows 지원 (catalina.bat)
- src/core/LogStreamer.ts
  - 서버별 독립 OutputChannel (`Tom Cattery: {서버명}`)
  - stdout/stderr 실시간 스트리밍
- src/core/InstanceManager.ts에 updateStatus() 추가
- serverCommands.ts
  - Start/Stop/Restart 실제 구현 (TreeView 인라인 버튼 + 커맨드 팔레트)
  - 커맨드 팔레트 실행 시 QuickPick으로 서버 선택 (상태 기반 필터링)
  - Open Logs 커맨드 구현
  - Delete Server에 실행 중 삭제 방지 추가
- extension.ts
  - ProcessManager, LogStreamer 초기화
  - 상태 변경 콜백으로 TreeView 실시간 갱신
  - deactivate()에서 프로세스/채널 정리

### F5 확인 방법
- TreeView에서 서버 우클릭 → Start → Tomcat 기동 로그 출력
- localhost:{port} 접속 → Tomcat 기본 페이지
- TreeView 아이콘 ○→●(초록) 변경 확인
- Stop → 서버 중지 → 아이콘 ●→○ 복귀
- Restart 동작 확인
- Open Logs → OutputChannel 표시

---

## Phase 4: WAR Exploded 배포 (완료)

**작업일**: 2026-02-07
**브랜치**: feature/phase-1

### 완료 항목
- src/core/DeployManager.ts
  - WAR 파일을 exploded 형태로 webapps/ 하위에 배포
  - Context Path 매핑: `/` → `ROOT/`, `/api` → `api/`, `/app/v2` → `app#v2/`
  - 증분 배포: 파일 크기 + 내용(Buffer.equals) 비교로 변경된 파일만 덮어쓰기
  - WAR에서 삭제된 파일 자동 제거
  - 실행 중인 서버에 배포 시 context.xml touch로 리로드 트리거
  - Gradle Build Task Hook: VSCode Task API로 `gradlew {taskName}` 실행, 종료 코드 확인
  - `${workspaceFolder}` 변수 치환 지원
- src/core/InstanceManager.ts
  - addDeployment(): 같은 contextPath 기존 배포 대체, 메타데이터 저장
  - removeDeployment(): contextPath 기준 배포 제거
  - saveMetadata(): .tom-cattery.json에 deployments 배열 동기화
- src/commands/serverCommands.ts
  - deploy 커맨드: WAR 파일 선택 → Context Path 입력 → Gradle task(선택) → 배포
  - 기존 배포 Redeploy 지원 (QuickPick 선택)
  - redeployAll 커맨드: 서버의 모든 배포를 순차 재배포
- src/extension.ts
  - DeployManager 초기화 및 registerServerCommands에 전달

### F5 확인 방법
- Deploy → WAR 파일 선택 → Context Path 지정 → webapps/{contextDir}/ 에 파일 배포됨
- 브라우저에서 해당 Context Path 접속 가능
- Redeploy → 변경 파일만 업데이트 (updated/removed 카운트 표시)
- Gradle 빌드 태스크 연동 (선택사항)

### 추가 개선 (Phase 4 이후)
- Deploy → Add Deployment (설정 등록) + Deploy (배포 실행) 분리
- TreeView 계층 구조: 서버 → 하위 배포 목록 (WAR명 + context path)
- Edit Deployment: 배포 아이템 우클릭 → Context Path, WAR 경로, Build Task 수정
- Remove Deployment: 배포 아이템 개별 삭제
- Clean Deployment: 서버 레벨 전체/개별 배포 삭제

---

## Phase 5: 원클릭 디버그 (완료)

**작업일**: 2026-02-07
**브랜치**: feature/phase-1

### 완료 항목
- src/core/ProcessManager.ts
  - `startServer(instance, mode)` — `'run' | 'jpda'` 모드 지원
  - `catalina.sh jpda run`으로 JPDA 디버그 모드 기동
  - 기동 완료 시 `'debugging'` 상태로 전환
  - `restartServer`도 mode 전파
- src/core/InstanceManager.ts
  - `injectJpdaConfig()` — setenv.sh/bat에 JPDA 설정 마커 블록 주입 (idempotent)
  - `removeJpdaConfig()` — 디버그 종료 시 JPDA 블록 제거
  - 마커: `# ===== TOM CATTERY DEBUG CONFIG (auto-managed) =====`
- src/core/DebugController.ts (신규)
  - `debugServer()` — 전체 디버그 플로우 오케스트레이션
  - `ensurePortAvailable()` — net.createServer로 포트 사용 가능 확인
  - `waitForJpdaReady()` — TCP 연결 폴링 (500ms 간격, 30초 타임아웃)
  - `attachDebugger()` — vscode.debug.startDebugging() 자동 attach (launch.json 불필요)
  - `onDebugSessionEnd()` — 디버그 종료 시 JPDA 설정 정리
  - 에러 처리: 포트 충돌, 타임아웃, attach 실패, Java Debug 확장 미설치
- src/commands/serverCommands.ts
  - debugServer 스텁 → DebugController.debugServer() 호출로 교체
  - withProgress로 진행 상태 표시
- src/extension.ts
  - DebugController 초기화 및 전달
  - deactivate()에서 디버그 세션 정리

### F5 확인 방법
- TreeView에서 서버 Debug(🐛) 버튼 클릭
- OutputChannel에서 JPDA 모드 기동 로그 확인
- VSCode Debug 패널에 "Tom Cattery: {서버명}" 세션 자동 연결
- Java 소스에 브레이크포인트 → 브라우저 요청 → 코드에서 멈춤
- 디버그 세션 종료 → setenv.sh에서 JPDA 블록 자동 제거

---

## Phase 6a: Auto Deploy (완료)

**작업일**: 2026-02-07
**브랜치**: feature/phase-1

### 완료 항목
- src/core/DeployManager.ts
  - `setupWatchers(instance)` — autoDeploy가 true인 deployment에 대해 FileSystemWatcher 생성
  - `disposeWatchers(serverName)` / `disposeAllWatchers()` — watcher 정리
  - `inferWatchPaths(warPath)` — WAR 경로에서 watchPath 추론 (build/libs → src/main/webapp)
  - `onFileChanged()` — 파일 변경 감지 시 확장자별 분기
  - `syncSingleFile()` — JSP/HTML/CSS/JS 등 Hot Sync (즉시 복사)
  - `onFileDeleted()` — 소스 삭제 시 webapps에서도 삭제
  - `debouncedBuild()` — .java 변경 시 1초 debounce 후 Gradle 빌드 + 재배포
  - `HOT_DEPLOY_EXTENSIONS` — .jsp, .html, .css, .js, .json, .xml, .properties, 이미지 등
  - `setLogStreamer()` — OutputChannel 연결
- src/extension.ts
  - 서버 상태 변경 콜백에 watcher 생명주기 관리 추가
  - running/debugging 전환 시 `setupWatchers()`, stopped 전환 시 `disposeWatchers()`
  - deactivate()에서 `disposeAllWatchers()` 호출
- src/commands/serverCommands.ts
  - `toggleAutoDeploy` 커맨드 추가 (deployment 아이템에서 토글)
  - 토글 시 서버 실행 중이면 즉시 watcher 갱신
  - `addDeployment`에서 `inferWatchPaths()`로 watchPaths 기본값 설정
- src/views/ServerTreeProvider.ts
  - DeploymentTreeItem에 autoDeploy 상태 표시 (eye 아이콘 + blue 컬러)
  - contextValue 분리: `deployment` / `deployment-auto`
  - 툴팁에 Auto Deploy 상태, Watch Paths 표시
- package.json
  - `toggleAutoDeploy` 커맨드 및 메뉴 추가
  - deployment 아이템 inline 버튼 (deploy + toggle auto deploy)
  - 우클릭 메뉴에도 Toggle Auto Deploy 추가

### F5 확인 방법
- 서버에 deployment 추가 → TreeView에서 deployment 우클릭 → Toggle Auto Deploy
- 아이콘이 package → eye(파란색)로 변경됨
- 서버 기동 → OutputChannel에 `[Tom Cattery] Auto-deploy watchers active.` 메시지
- `src/main/webapp/index.jsp` 수정 → `[Hot Sync] index.jsp` 로그 + webapps에 자동 복사
- `.java` 수정 → 1초 후 `[Auto Deploy] Java source changed. Building and redeploying...` → Gradle 빌드 + WAR 재배포
- 서버 중지 → watcher 자동 정리

---

## Phase 6b: Config Webview — 서버 설정 UI (완료)

**작업일**: 2026-02-07
**브랜치**: feature/phase-1

### 완료 항목
- src/core/ConfigParser.ts
  - `updateServerXmlPorts(xmlPath, oldPorts, newPorts)` — 기존 커스텀 포트값을 새 값으로 교체 (기본 8080/8005가 아닌 이미 변경된 포트도 처리)
- src/core/InstanceManager.ts
  - `saveFullConfig(instance)` — .tom-cattery.json에 전체 설정 저장 (ports, javaHome, jvmArgs, envVars, debug)
  - 포트 변경 시 `ConfigParser.updateServerXmlPorts()` 자동 호출
  - `regenerateSetenvSh()` / `regenerateSetenvBat()` — JAVA_HOME, JVM args, 환경변수를 마커 블록(`TOM CATTERY SETENV CONFIG`) 방식으로 재생성
  - `getInstance(name)` — 이름으로 인스턴스 조회 헬퍼
- src/views/ConfigWebviewProvider.ts (신규)
  - WebviewPanel 기반 설정 에디터 (에디터 영역에 탭으로 열림)
  - 폼 섹션:
    - **General**: Server Name(읽기전용), Runtime Path(읽기전용), JAVA_HOME(편집 + Browse 버튼)
    - **Ports**: HTTP, HTTPS, Shutdown, AJP, Debug 포트 (숫자 입력)
    - **JVM Options**: textarea (한 줄에 하나씩)
    - **Environment Variables**: key-value 테이블 (추가/삭제)
    - **Debug**: suspend, autoAttach 체크박스 토글
  - 메시지 핸들링: saveConfig, applyAndRestart, browseJavaHome, loadConfig
  - 같은 서버 패널 중복 열기 방지 (기존 패널 포커스)
  - VSCode 테마 호환: `--vscode-*` CSS 변수 사용
  - 서버 실행 중 Save 시 "Restart required" 경고 + 즉시 재시작 옵션
- src/commands/serverCommands.ts
  - openConfig 스텁 → ConfigWebviewProvider.openConfig() 실제 구현으로 교체
  - 커맨드 팔레트에서도 서버 선택 후 설정 열기 가능
- src/extension.ts
  - ConfigWebviewProvider 초기화 및 registerServerCommands에 전달
  - deactivate()에서 패널 정리

### F5 확인 방법
1. TreeView → 서버 우클릭 → "Edit Configuration" → Webview 패널이 에디터 영역에 열림
2. 포트 변경 → Save → `.tom-cattery.json`의 포트값 업데이트 + `conf/server.xml` 포트 교체 확인
3. JVM args 입력 (예: `-Xms512m`) → Save → `bin/setenv.sh` 내 마커 블록에 반영 확인
4. 환경변수 추가 (예: `APP_ENV=dev`) → Save → setenv.sh에 `export APP_ENV="dev"` 추가 확인
5. JAVA_HOME Browse → 폴더 선택 → 입력칸에 경로 반영
6. Debug suspend/autoAttach 토글 → Save → .tom-cattery.json에 반영
7. 서버 실행 중 Save → "Restart required" 경고 팝업 → "Restart Now" 클릭 시 재기동
8. "Save & Restart" 버튼 → 설정 저장 후 서버 즉시 재시작
9. 같은 서버 Config를 두 번 열면 기존 패널 포커스 (중복 생성 안됨)

## Phase 14: 서버 복제 (완료)

**작업일**: 2026-02-07

### 완료 항목
- `InstanceManager.cloneInstance()` 메서드 추가
  - CATALINA_BASE 전체 복사 → webapps/logs/work/temp 클린업 → 새 포트 할당 → server.xml 패치 → setenv 재생성
- `tomCattery.cloneServer` 커맨드 (서버 우클릭 메뉴 2_config 그룹)
- package.json에 커맨드/메뉴 선언

## Phase 15: Tomcat 로그 파일 뷰어 (완료)

**작업일**: 2026-02-07

### 완료 항목
- `tomCattery.openLogs` 커맨드 확장
  - QuickPick: 콘솔 출력 (stdout) / 로그 파일 열기
  - `{CATALINA_BASE}/logs/` 디렉터리 스캔 → .log/.out/.txt 파일 목록 (크기, 수정일 표시)
  - 선택 파일을 TextDocument로 열기

## Phase 16: Jest 테스트 코드 (완료)

**작업일**: 2026-02-07

### 완료 항목
- Jest + ts-jest 셋업 (jest.config.js, devDependencies)
- GradleProjectScanner 테스트: parseIncludeStatements(), containsWarPlugin()
- MetricsCollector 테스트: formatUptime(), formatMemoryMb()
- DeployManager 테스트: contextPathToDir()
- 전체 31개 테스트 통과

## Phase 17: 마켓플레이스 배포 준비 (완료)

**작업일**: 2026-02-07

### 완료 항목
- package.json: publisher, license, repository, keywords, galleryBanner, version 0.1.0
- README.md: 기능 개요, 시작 가이드, 명령어 목록, 설정 테이블
- CHANGELOG.md: v0.1.0 변경 이력
- LICENSE: MIT 라이선스
- .vscodeignore: jest.config.js, __tests__, 설계 문서 제외
- VSIX 패키징 성공: tom-cattery-0.1.0.vsix (228 KB)

---

## 후속 개선: 버그 수정 + UX 개선 (완료)

**작업일**: 2026-02-07
**브랜치**: feature/phase-1

### 버그 수정
- **publisher 변경 마이그레이션**: publisher가 `woongki` → `tofu9`로 변경되면서 globalStorage 경로 불일치 발생. `migrateFromOldPublisher()` 함수로 기존 데이터 자동 이전
- **Gradle deployment TreeView 라벨 누락**: `warPath.includes('*')` 분기 추가하여 프로젝트명 표시
- **Webview 템플릿 리터럴 충돌**: `${CATALINA_BASE}` 문자열이 TypeScript 보간으로 해석되어 "Webview is disposed" 에러 → 일반 텍스트로 변경

### 신규 기능
- **워크스페이스 설정 저장/감지**: `tomCattery.saveToWorkspace` 커맨드 → `.vscode/tom-cattery.json` 저장. Extension 활성화 시 파일 감지하여 Import 제안
- **Config Webview 배포 경로 표시**: Deploy Path를 `CATALINA_BASE/webapps/{contextDir}` 형식으로 표시 + 폴더 열기 버튼

### UX 개선
- **codicon 아이콘 통일**: `@vscode/codicons` 패키지 도입. 이모지(📁🗑) → VSCode 네이티브 아이콘 (`codicon-folder-opened`, `codicon-trash`, `codicon-settings-gear`)
- **읽기전용 필드 텍스트화**: Server Name, Catalina Home, Catalina Base, Deploy Path → `<input readonly>` 제거, `<span class="field-value">` 텍스트로 변경. 편집 가능/불가 시각적 구분
- **버튼 아이콘화**: "Browse...", "Remove", "변경..." 등 텍스트 버튼을 모두 codicon 아이콘 버튼으로 교체
- **import/export 커맨드 아이콘 변경**: `$(download)` / `$(arrow-up)`

### 커밋 이력
- `16a2895` fix: publisher를 tofu9로 변경 + globalStorage 경로 마이그레이션
- `f553c7b` fix: Gradle 배포 시 TreeView에 프로젝트명 표시
- `4a80cfe` feat: 워크스페이스 설정 저장/감지 기능
- `b8cb0f2` feat: Config Webview에 배포 경로 표시 + 폴더 열기 기능
- `e3ddb15` refactor: Config Webview 버튼 아이콘 통일 + Deploy Path 개선
- `b246dd7` refactor: Config Webview UX 개선 — codicon 아이콘 + 읽기전용 필드 텍스트화

### 최종 빌드
- VSIX 패키징 성공: tom-cattery-0.1.0.vsix (298 KB, 56 files)
- 다음 작업: Windows 환경 테스트

---

## v0.3.0: 워크스페이스별 서버 관리 + id 기반 CATALINA_BASE (완료)

**작업일**: 2026-05-15
**브랜치**: main

### 배경
이전까지 서버 정보는 `globalStorage/servers/{name}/`에 전역으로 저장되어 모든 워크스페이스에서 동일하게 보였다.
Eclipse처럼 워크스페이스별로 서버를 관리하고, 워크스페이스 간 동일 이름 서버의 충돌을 방지하기 위한 구조로 전환했다.

### 핵심 변경 — 두 영역 분리
Eclipse의 관리 방식을 차용:
- **레지스트리(설정/소속)** = 워크스페이스 `.vscode/tom-cattery.json` — 진실의 원천, 팀 공유 가능
- **CATALINA_BASE 실체(런타임 상태)** = `globalStorage/servers/{id}/` — UUID 키로 분리, 무거운 webapps/logs/work는 워크스페이스 밖에 보관
- Eclipse 매핑: `.metadata/.../tmp0/` ↔ globalStorage 실체 / "Servers" 프로젝트 ↔ `.vscode/tom-cattery.json`

### 완료 항목
- **타입**: `TomcatInstance`에 `id`, `runtimeVersion?`, `runtimeType?`, `provisioned?` 추가. `TomCatteryServerExport`에 `id?` 추가
- **InstanceManager 리팩터링**:
  - 생성자에 `registryPath`(워크스페이스 `.vscode/tom-cattery.json`) 추가
  - `loadInstances()`를 globalStorage 스캔 → 레지스트리 파싱으로 교체
  - CATALINA_BASE 디렉터리 키를 `{name}` → `{id}`(UUID v4)로 변경
  - `ensureBase()` 신규: 멱등 lazy provisioning — base 없으면 인스턴스 정의로부터 재생성
  - base 메타에 `origin: { workspace, name }` 역참조 기록 — 레지스트리 복붙(동일 id가 다른 워크스페이스 base를 가리킴) 충돌 감지 후 새 id로 분리
  - `createInstance`/`saveFullConfig`/`addDeployment`/`removeDeployment`/`deleteInstance`/`cloneInstance`가 base 메타 + 레지스트리 write-through
  - `injectJpdaConfig`도 ensureBase 호출 (디버그 진입 시 base 자동 생성 보장)
- **마이그레이션** (`migrateToWorkspaceRegistry`): 기존 `servers/{name}/` → `servers/{id}/`로 이동하면서 현재 워크스페이스 레지스트리에 일괄 등록
- **명령 정리**:
  - `tomCattery.startServer`/`debugServer`에 `ensureBase()` 호출 추가
  - `tomCattery.addServer`에 워크스페이스 열림 가드 추가
  - `tomCattery.saveToWorkspace` 재구현 — `saveRegistry()` 호출로 간소화 (레지스트리는 항상 자동 동기화되므로 수동 백업 용도)
  - `tomCattery.resetGlobalStorage`가 워크스페이스 레지스트리 파일도 함께 삭제
  - 기존 `detectWorkspaceConfig`(import 제안 알림) 제거 — 레지스트리가 곧 정상 로드 경로
- **트리뷰**: 미프로비저닝 서버는 `(미생성)` 설명 + `cloud-download` 아이콘으로 시각 구분, 툴팁에 "기동 시 자동 생성" 안내

### 검증
- npm run compile 통과 (tsc -p ./)
- Jest 테스트 46개 전체 통과

### 동작 시나리오
1. 워크스페이스 A에서 서버 생성 → A의 `.vscode/tom-cattery.json`에만 기록 → B 열면 안 보임
2. `.vscode/tom-cattery.json`을 git 커밋 후 다른 머신에서 clone → 미프로비저닝 상태로 트리에 보임 → 기동 시 base 자동 생성
3. 두 워크스페이스에서 같은 이름 서버 생성 → globalStorage에서 UUID로 분리되어 충돌 없음
4. 레지스트리 복붙(동일 id 공유) → 기동 시 origin 불일치 감지 → 새 id로 분리 생성
