# Tom Cattery

**VSCode에서 Apache Tomcat 서버를 관리하는 Extension**

여러 Tomcat 인스턴스를 한 곳에서 생성, 기동, 디버그, 배포할 수 있습니다.

## 주요 기능

- **서버 관리**: Activity Bar에서 Tomcat 서버 추가/삭제/복제
- **원클릭 디버그**: Debug 버튼 한 번으로 JPDA 설정 → Tomcat 기동 → 디버거 자동 연결
- **WAR Exploded 배포**: WAR 파일을 자동으로 압축 해제하여 webapps에 배포
- **Hot Sync**: JSP, HTML, CSS 파일 수정 시 빌드 없이 즉시 반영
- **자동 배포**: 파일 저장 시 변경 감지 → 자동 배포 (autoDeploy)
- **Gradle Multi-Module 지원**: 워크스페이스의 WAR 모듈을 자동 스캔하여 일괄 등록
- **Tomcat 다운로드**: Apache 미러에서 Tomcat을 자동으로 다운로드
- **서버 설정 UI**: Webview 기반 설정 폼 (포트, JVM 옵션, 환경 변수)
- **서버 상태 모니터링**: Uptime, 메모리 사용량 실시간 표시
- **로그 뷰어**: 콘솔 출력 + 로그 파일 열기
- **Import/Export**: 서버 설정을 JSON으로 내보내기/가져오기
- **Windows/macOS/Linux**: 크로스 플랫폼 지원

## 시작하기

### 요구 사항

- VSCode 1.85 이상
- JDK 8 이상 (`java.configuration.runtimes` 설정 권장)
- [Debugger for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-debug) Extension (디버그 기능용)

### 서버 추가

1. Activity Bar에서 Tom Cattery 아이콘 클릭
2. `+` 버튼 또는 커맨드 팔레트 → `Tom Cattery: New Server`
3. Tomcat 런타임 선택 (로컬 경로 또는 자동 다운로드)
4. 서버 이름, JDK, 포트 설정

### 배포

1. 서버 우클릭 → `Add Deployment`
2. WAR 파일 경로 및 Context Path 설정
3. `Deploy` 버튼으로 배포 실행
4. `Toggle Auto Deploy`로 자동 배포 활성화

### 디버그

1. 서버 TreeView에서 `Debug` 버튼 (벌레 아이콘) 클릭
2. Tomcat이 JPDA 모드로 기동되고 디버거가 자동 연결됨
3. Java 소스에 Breakpoint 설정 → 브라우저에서 요청 → 코드에서 정지

## 명령어 목록

| 명령어 | 설명 |
|--------|------|
| `Tom Cattery: New Server` | 새 서버 추가 |
| `Tom Cattery: Start Server` | 서버 시작 |
| `Tom Cattery: Stop Server` | 서버 중지 |
| `Tom Cattery: Restart Server` | 서버 재시작 |
| `Tom Cattery: Debug Server` | 디버그 모드로 시작 |
| `Tom Cattery: Clone Server` | 서버 복제 |
| `Tom Cattery: Add Deployment` | 배포 추가 |
| `Tom Cattery: Deploy` | 배포 실행 |
| `Tom Cattery: Redeploy All` | 전체 재배포 |
| `Tom Cattery: Add Gradle Deployments` | Gradle WAR 모듈 일괄 등록 |
| `Tom Cattery: Edit Configuration` | 서버 설정 UI 열기 |
| `Tom Cattery: Open Logs` | 로그 보기 |
| `Tom Cattery: Export Server Config` | 설정 내보내기 |
| `Tom Cattery: Import Server Config` | 설정 가져오기 |
| `Tom Cattery: Download Runtime` | Tomcat 다운로드 |
| `Tom Cattery: Delete Server` | 서버 삭제 |

## 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `tomCattery.defaultHttpPort` | `8080` | 새 서버의 기본 HTTP 포트 |
| `tomCattery.autoResolvePortConflicts` | `true` | 포트 충돌 시 자동으로 빈 포트 할당 |
| `tomCattery.openBrowserOnStart` | `true` | 서버 시작 시 브라우저 자동 열기 |

## 라이선스

MIT
