# 변경 이력

## [0.3.0] - 2026-05-15

### 핵심 변경 — 워크스페이스별 서버 관리
Eclipse 방식을 차용해 **레지스트리(설정/소속)** 와 **CATALINA_BASE 실체(런타임 상태)** 를 분리.
이전까지 globalStorage에 전역 저장되던 서버 정보를 워크스페이스 단위로 관리하도록 전환.

- **레지스트리**: 워크스페이스 `.vscode/tom-cattery.json` — 진실의 원천, 팀 공유 가능
- **실체**: `globalStorage/servers/{id}/` — UUID 키로 분리, 무거운 webapps/logs/work는 워크스페이스 밖에 보관
- 워크스페이스 간 동일 이름 서버 충돌 방지

### 추가
- **id 기반 CATALINA_BASE**
  - `TomcatInstance`에 `id` (UUID v4), `runtimeVersion`, `runtimeType`, `provisioned` 필드 추가
  - CATALINA_BASE 디렉터리 키를 `{name}` → `{id}` 로 변경
  - base 메타에 `origin: { workspace, name }` 역참조 기록 → 레지스트리 복붙으로 동일 id가 다른 워크스페이스 base를 가리키는 충돌 감지 시 새 id로 자동 분리
- **Lazy Provisioning**
  - `ensureBase()` — base 디렉터리 없으면 인스턴스 정의로부터 멱등하게 재생성
  - Start / Debug / JPDA 주입 시점에 자동 호출 → 다른 머신에서 clone 받자마자 기동 가능
- **미프로비저닝 서버 시각화**
  - 트리뷰에 `(미생성)` 설명 + `cloud-download` 아이콘 표시
  - 툴팁에 "기동 시 자동 생성" 안내
- **자동 마이그레이션** (`migrateToWorkspaceRegistry`)
  - 기존 `servers/{name}/` → `servers/{id}/` 로 이동하면서 현재 워크스페이스 레지스트리에 일괄 등록

### 변경
- `loadInstances()` 가 globalStorage 스캔 → 워크스페이스 레지스트리 파싱으로 교체
- `createInstance` / `saveFullConfig` / `addDeployment` / `removeDeployment` / `deleteInstance` / `cloneInstance` 가 base 메타와 레지스트리에 write-through
- `tomCattery.addServer` 에 워크스페이스 열림 가드 추가
- `tomCattery.saveToWorkspace` 간소화 — 레지스트리는 자동 동기화되므로 수동 백업 용도로 축소
- `tomCattery.resetGlobalStorage` 가 워크스페이스 레지스트리 파일도 함께 삭제

### 제거
- 기존 `detectWorkspaceConfig` (import 제안 알림) — 레지스트리가 곧 정상 로드 경로이므로 불필요

### 동작 시나리오
1. 워크스페이스 A에서 서버 생성 → A의 `.vscode/tom-cattery.json` 에만 기록 → B 열면 안 보임
2. `.vscode/tom-cattery.json` 을 git 커밋 후 다른 머신에서 clone → 미프로비저닝 상태로 트리에 보임 → 기동 시 base 자동 생성
3. 두 워크스페이스에서 같은 이름 서버 생성 → globalStorage 에서 UUID로 분리되어 충돌 없음
4. 레지스트리 복붙(동일 id 공유) → 기동 시 origin 불일치 감지 → 새 id로 분리 생성

## [0.2.0] - 2026-05-13

### 개선
- **Gradle 모듈 스캐너 강화**
  - `:` prefix 없는 `include 'web-app'` 형태 지원
  - 다중 라인 include 구문 (`include 'a',\n        'b'`) 파싱
  - 라인 주석(`//`) 안의 include 무시
  - 루트의 `subprojects {}` / `allprojects {}` 블록에서 자식 일괄 war 적용 감지
  - 루트의 `configure(subprojects.findAll {...}) {}` / `configure(project(':a')) {}` 등 DevOn Enterprise 스타일 동적 적용도 감지
  - 멀티 모듈 환경에서도 루트가 자체 war 면 루트 모듈 포함
  - `src/main/webapp` 디렉터리 존재 여부를 폴백 시그널로 사용
- **Spring Boot bootWar 지원**
  - 모듈에 `org.springframework.boot` 플러그인이 적용되면 build task 를 `:module:bootWar` 로 자동 설정
  - 루트의 `subprojects {}` / `configure(...) {}` 를 통한 일괄 적용도 감지
  - `containsPlugin` / `appliesPluginToChildren` 헬퍼로 일반화
- **Add Deployment QuickPick UX**
  - 기본 체크 상태를 "모두 해제"로 변경 — 사용자가 원하는 모듈만 선택
  - 이미 등록된 모듈은 `(이미 등록됨)` 라벨로 구분
  - placeholder 문구 명료화
- **Gradle deployment 자동 빌드+배포**
  - 서버 Start / Restart / Debug 시 `type === 'gradle'` deployment 를 먼저 빌드 + WAR explode 후 기동
  - Gradle 의 incremental build 로 변경 없으면 빠르게 UP-TO-DATE

### 버그 수정
- **macOS 공백 경로에서 서버 기동 실패**
  - `~/Library/Application Support/...` 같이 공백 포함 경로에서 `/bin/sh: Application: No such file or directory` 오류
  - `ProcessManager` 의 `spawn` 을 OS별로 분리: Unix 는 shell 우회 직접 실행, Windows 는 `cmd.exe /c` 로 wrap

## [0.1.0] - 2026-02-07

### 추가
- Tomcat 서버 생성/삭제/복제
- 서버 기동/중지/재시작
- 원클릭 디버그 (JPDA 자동 설정 + 디버거 자동 연결)
- WAR Exploded 배포 (증분 배포 지원)
- Hot Sync (JSP/HTML/CSS 즉시 반영)
- 자동 배포 (파일 저장 시 자동 감지)
- Gradle Multi-Module WAR 모듈 스캔 및 일괄 등록
- Webview 기반 서버 설정 UI (포트, JVM 옵션, 환경 변수)
- Tomcat 자동 다운로드 (Apache 미러)
- 서버 상태 모니터링 (Uptime, 메모리)
- 로그 뷰어 (콘솔 출력 + 로그 파일)
- 서버 설정 Import/Export (JSON)
- 브라우저 자동 열기
- Windows/macOS/Linux 지원
