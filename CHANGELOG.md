# 변경 이력

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
