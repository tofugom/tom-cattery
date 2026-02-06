# Tom Cattery - 기술 스택 가이드 & 개발 전략

## 1. 현재 설계 문서 상태 평가

```mermaid
graph LR
    subgraph "✅ 충분한 부분"
        A1["아키텍처 구조"]
        A2["모듈 의존 관계"]
        A3["핵심 워크플로우<br/>(시퀀스 다이어그램)"]
        A4["인터페이스 정의"]
        A5["핵심 코드 스케치<br/>(DebugController, DeployManager)"]
        A6["디렉토리 구조"]
        A7["UI 레이아웃"]
    end

    subgraph "🔄 Claude Code에서 보완 가능"
        B1["실제 코드 구현"]
        B2["에러 핸들링 상세"]
        B3["테스트 코드"]
        B4["패키지 의존성 세부"]
        B5["Webview HTML/CSS"]
    end

    subgraph "⚠️ 알아두면 좋은 것"
        C1["VSCode Extension API 구조"]
        C2["Extension 개발 도구 체인"]
        C3["디버깅 & 테스트 방법"]
        C4["Marketplace 배포 절차"]
    end

    A1 --> B1
    A4 --> B1
    C1 -->|"이해 필요"| B1
```

**결론: 설계 고도화보다 기술 스택 이해 → Claude Code 작업 시작이 효율적.**

---

## 2. VSCode Extension 개발 기술 스택 전체 지도

### 2.1 반드시 알아야 하는 것

```mermaid
graph TB
    subgraph "🔴 필수 (이것만 알면 시작 가능)"
        TS["TypeScript<br/>Extension 전체 언어"]
        NODE["Node.js 런타임<br/>Extension Host 환경"]
        API["VSCode Extension API<br/>핵심 진입점"]
        PKG["package.json<br/>Extension 선언부 (매우 중요)"]
    end

    subgraph "🟡 중요 (개발하면서 익힘)"
        TV["TreeView API<br/>사이드바 서버 목록"]
        WV["Webview API<br/>설정 UI 화면"]
        CMD["Command API<br/>커맨드 팔레트 등록"]
        DBG["Debug API<br/>디버거 연동"]
        TASK["Task API<br/>Gradle 빌드 연동"]
    end

    subgraph "🟢 부가 (필요할 때 학습)"
        MKT["vsce CLI<br/>Marketplace 배포"]
        TEST["Mocha + VSCode Test<br/>Extension 테스트"]
        CI["GitHub Actions<br/>CI/CD"]
    end

    TS --> API
    NODE --> API
    API --> TV
    API --> WV
    API --> CMD
    API --> DBG
    API --> TASK
    
    TV --> MKT
    WV --> MKT
```

### 2.2 기술 스택 상세

| 기술 | 용도 | Tom Cattery에서의 역할 | 학습 난이도 |
|------|------|----------------------|------------|
| **TypeScript** | Extension 구현 언어 | 모든 로직 | ⭐⭐ (JS 안다면 쉬움) |
| **Node.js** | Extension 실행 환경 | child_process, fs, net 등 | ⭐ |
| **VSCode Extension API** | Extension 기능 등록 | TreeView, Webview, Command, Debug | ⭐⭐⭐ |
| **package.json** | Extension 메타데이터 | command, view, keybinding 선언 | ⭐⭐ |
| **Webview (HTML/CSS/JS)** | 커스텀 UI | 서버 설정 폼 | ⭐⭐ |
| **XML 파서 (fast-xml-parser)** | server.xml 처리 | 포트 패치, 설정 편집 | ⭐ |
| **adm-zip** | WAR 파일 처리 | exploded 배포 | ⭐ |
| **vsce** | Marketplace 배포 도구 | .vsix 패키징 & 배포 | ⭐ |

---

## 3. VSCode Extension 핵심 개념 (5분 요약)

### 3.1 Extension 구조

```mermaid
graph TB
    subgraph "Extension 패키지"
        PJ["package.json<br/>📋 Extension의 이력서<br/>- 어떤 command가 있는지<br/>- 어떤 view가 있는지<br/>- 언제 활성화되는지<br/>전부 여기에 선언"]
        
        SRC["src/extension.ts<br/>🚀 진입점<br/>activate() 함수에서 시작"]
        
        VIEWS["src/views/<br/>🖥 UI 로직<br/>TreeView, Webview"]
        
        CMDS["src/commands/<br/>⚡ 커맨드 핸들러<br/>사용자 액션 처리"]
        
        CORE["src/core/<br/>🧠 비즈니스 로직<br/>Instance, Process, Deploy"]
    end

    PJ -->|"선언"| SRC
    SRC -->|"등록"| VIEWS
    SRC -->|"등록"| CMDS
    CMDS -->|"호출"| CORE
```

### 3.2 Extension 생명주기

```mermaid
sequenceDiagram
    participant VS as VSCode
    participant EXT as Extension (Tom Cattery)
    participant USER as User

    VS->>VS: package.json 읽기<br/>"activationEvents" 확인
    
    Note over VS: 사용자가 Tom Cattery 뷰를 열거나<br/>tomCattery.* 커맨드 실행 시
    
    VS->>EXT: activate(context) 호출
    EXT->>EXT: TreeView 등록
    EXT->>EXT: Command 핸들러 등록
    EXT->>EXT: Webview Provider 등록
    EXT-->>VS: 활성화 완료
    
    USER->>VS: 커맨드 팔레트: "Tom Cattery: New Server"
    VS->>EXT: command handler 실행
    EXT-->>USER: Quick Pick UI 표시
    
    Note over VS: VSCode 종료 시
    VS->>EXT: deactivate() 호출
    EXT->>EXT: 실행 중인 Tomcat 정리
    EXT->>EXT: File Watcher 해제
```

### 3.3 package.json이 왜 중요한가

VSCode Extension에서 `package.json`은 **단순한 의존성 파일이 아니라 Extension의 전체 선언부**이다.  
코드를 아무리 잘 짜도 여기에 선언하지 않으면 VSCode가 인식하지 못한다.

```
┌─────────────────────────────────────────────────┐
│  package.json의 역할                             │
├─────────────────────────────────────────────────┤
│                                                 │
│  일반 npm 프로젝트:                              │
│    package.json = 의존성 + 스크립트              │
│                                                 │
│  VSCode Extension:                              │
│    package.json = 의존성 + 스크립트              │
│                  + 모든 커맨드 선언              │
│                  + 모든 뷰(TreeView) 선언        │
│                  + 활성화 조건 선언              │
│                  + 키바인딩 선언                 │
│                  + 설정(configuration) 스키마     │
│                  + 메뉴/컨텍스트메뉴 선언        │
│                  + 아이콘/테마 선언              │
│                                                 │
│  → "contributes" 섹션이 Extension의 모든 것      │
└─────────────────────────────────────────────────┘
```

---

## 4. 개발 환경 셋업

### 4.1 필요한 도구

```bash
# 1. Node.js (LTS 권장)
node -v   # 18.x 이상

# 2. VSCode Extension 생성기
npm install -g yo generator-code

# 3. Extension 패키징/배포 도구
npm install -g @vscode/vsce

# 4. 프로젝트 생성
yo code
#   ? What type of extension? → New Extension (TypeScript)
#   ? Name? → tom-cattery
#   ? Identifier? → tom-cattery
#   ? Description? → 🐱 Tomcat Server Manager for VSCode
#   ? Initialize git? → Yes
#   ? Package manager? → npm
```

### 4.2 생성되는 프로젝트 구조

```
tom-cattery/
├── .vscode/
│   ├── launch.json          ← F5로 Extension 디버그 실행
│   └── tasks.json           ← 빌드 태스크
├── src/
│   └── extension.ts         ← 진입점 (여기서부터 확장)
├── package.json             ← ⭐ Extension 선언부
├── tsconfig.json            ← TypeScript 설정
└── .vscodeignore            ← 패키징 시 제외 파일
```

### 4.3 개발 & 디버그 사이클

```mermaid
graph LR
    A["코드 수정"] --> B["F5 누르기"]
    B --> C["새 VSCode 창 열림<br/>(Extension Development Host)"]
    C --> D["Extension 테스트"]
    D --> E{동작 확인}
    E -->|"OK"| F["다음 기능"]
    E -->|"버그"| G["console.log 확인<br/>(Debug Console)"]
    G --> A
    F --> A
```

> **F5를 누르면** 현재 Extension이 설치된 새로운 VSCode 창이 뜬다.  
> 이 창에서 Tom Cattery를 실제로 테스트할 수 있다.  
> **별도 설치 없이** 코드 수정 → F5 → 테스트 사이클이 바로 돈다.

---

## 5. Tom Cattery에서 쓰는 주요 VSCode API

### 5.1 API 의존 관계 맵

```mermaid
graph TB
    subgraph "Tom Cattery 기능 → VSCode API 매핑"
        F1["서버 목록 사이드바"] -->|"사용"| A1["vscode.TreeDataProvider<br/>vscode.window.registerTreeDataProvider()"]
        
        F2["서버 설정 폼 UI"] -->|"사용"| A2["vscode.WebviewViewProvider<br/>HTML/CSS/JS로 자유 UI 구성"]
        
        F3["커맨드 팔레트<br/>(New Server, Start, Stop)"] -->|"사용"| A3["vscode.commands.registerCommand()"]
        
        F4["원클릭 디버그"] -->|"사용"| A4["vscode.debug.startDebugging()<br/>vscode.DebugConfiguration"]
        
        F5["Gradle 빌드 실행"] -->|"사용"| A5["vscode.tasks.executeTask()<br/>vscode.ShellExecution"]
        
        F6["자동 배포 감시"] -->|"사용"| A6["vscode.workspace.createFileSystemWatcher()"]
        
        F7["Tomcat 프로세스 관리"] -->|"사용"| A7["Node.js child_process.spawn()<br/>(VSCode API 아님, Node.js 표준)"]
        
        F8["로그 출력"] -->|"사용"| A8["vscode.window.createOutputChannel()"]
        
        F9["상태바 표시"] -->|"사용"| A9["vscode.window.createStatusBarItem()"]
        
        F10["서버 이름 입력<br/>런타임 선택"] -->|"사용"| A10["vscode.window.showInputBox()<br/>vscode.window.showQuickPick()"]
    end
```

### 5.2 API별 난이도 & 학습 순서

```mermaid
graph LR
    subgraph "Week 1: 기초"
        direction TB
        L1["1. Command 등록<br/>⭐ 가장 쉬움"]
        L2["2. InputBox / QuickPick<br/>⭐ 사용자 입력 받기"]
        L3["3. OutputChannel<br/>⭐ 로그 출력"]
    end
    
    subgraph "Week 2: UI"
        direction TB
        L4["4. TreeView<br/>⭐⭐ 서버 목록"]
        L5["5. StatusBar<br/>⭐ 상태 표시"]
    end
    
    subgraph "Week 3: 핵심"
        direction TB
        L6["6. FileSystemWatcher<br/>⭐⭐ 파일 감시"]
        L7["7. Task API<br/>⭐⭐ Gradle 연동"]
        L8["8. Debug API<br/>⭐⭐⭐ 디버거 연결"]
    end
    
    subgraph "Week 4: 고급"
        direction TB
        L9["9. Webview<br/>⭐⭐⭐ 설정 폼 UI"]
    end

    L1 --> L2 --> L3 --> L4 --> L5 --> L6 --> L7 --> L8 --> L9
```

---

## 6. npm 의존성 패키지

### 6.1 의존성 맵

```mermaid
graph TB
    subgraph "dependencies (런타임)"
        D1["fast-xml-parser<br/>server.xml 읽기/쓰기"]
        D2["adm-zip<br/>WAR 파일 압축 해제"]
        D3["portfinder<br/>사용 가능한 포트 탐색"]
    end

    subgraph "devDependencies (개발)"
        E1["typescript"]
        E2["@types/vscode<br/>VSCode API 타입 정의"]
        E3["@types/node"]
        E4["@vscode/test-electron<br/>Extension 통합 테스트"]
        E5["esbuild 또는 webpack<br/>Extension 번들링"]
        E6["@vscode/vsce<br/>패키징 & 배포"]
    end

    subgraph "내장 (설치 불필요)"
        F1["child_process<br/>Tomcat 프로세스"]
        F2["fs / fs.promises<br/>파일 시스템"]
        F3["net<br/>포트 체크"]
        F4["path<br/>경로 처리"]
        F5["https<br/>Tomcat 다운로드"]
    end

    style D1 fill:#efe
    style D2 fill:#efe
    style D3 fill:#efe
    style F1 fill:#eef
    style F2 fill:#eef
    style F3 fill:#eef
```

### 6.2 package.json 의존성 예시

```json
{
  "dependencies": {
    "fast-xml-parser": "^4.3.0",
    "adm-zip": "^0.5.10",
    "portfinder": "^1.0.32"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/vscode": "^1.85.0",
    "@types/node": "^20.0.0",
    "@types/adm-zip": "^0.5.5",
    "@vscode/test-electron": "^2.3.0",
    "esbuild": "^0.19.0",
    "@vscode/vsce": "^2.22.0"
  }
}
```

> **의존성이 매우 적다.** 대부분 Node.js 내장 모듈로 처리 가능.  
> Extension은 가벼울수록 좋으므로 이점이다.

---

## 7. Claude Code 작업 전략

### 7.1 권장 작업 순서

```mermaid
graph TB
    subgraph "Phase 0: 프로젝트 셋업"
        P0A["yo code로 프로젝트 생성"]
        P0B["npm 의존성 설치"]
        P0C["src/ 폴더 구조 잡기"]
    end

    subgraph "Phase 1: 뼈대 (F5로 확인 가능한 수준)"
        P1A["package.json contributes 선언<br/>(commands, views)"]
        P1B["extension.ts activate()"]
        P1C["빈 TreeView 표시"]
        P1D["'New Server' 커맨드<br/>→ InputBox로 이름 입력"]
    end

    subgraph "Phase 2: CATALINA_BASE"
        P2A["RuntimeManager<br/>(로컬 Tomcat 감지)"]
        P2B["InstanceManager<br/>(디렉토리 생성 + conf 복사)"]
        P2C["TreeView에 서버 표시"]
    end

    subgraph "Phase 3: 기동/중지"
        P3A["ProcessManager<br/>(catalina.sh run)"]
        P3B["LogStreamer<br/>(OutputChannel)"]
        P3C["TreeView 상태 반영"]
    end

    subgraph "Phase 4: 배포 & 디버그"
        P4A["DeployManager<br/>(WAR explode)"]
        P4B["DebugController<br/>(JPDA + auto-attach)"]
    end

    P0A --> P0B --> P0C --> P1A
    P1A --> P1B --> P1C --> P1D
    P1D --> P2A --> P2B --> P2C
    P2C --> P3A --> P3B --> P3C
    P3C --> P4A --> P4B
```

### 7.2 Claude Code에 넘길 때 팁

```
📌 Claude Code 프롬프트 전략

1. 설계 문서를 CLAUDE.md 또는 프로젝트 루트에 넣기
   → Claude Code가 컨텍스트로 자동 참조

2. Phase별로 작업 지시
   → "Phase 1의 프로젝트 셋업과 빈 TreeView까지 구현해줘"
   → 한번에 전체를 시키면 품질이 떨어짐

3. F5 테스트 가능한 단위로 끊기
   → 각 Phase가 끝나면 직접 F5로 확인
   → "여기까지 되면 F5로 뭐가 보여야 해?" 확인

4. package.json을 먼저 확정하기
   → contributes 섹션이 Extension의 뼈대
   → 이걸 먼저 완성하고 코드를 채우는 게 효율적
```

### 7.3 각 Phase 완료 후 확인 포인트

| Phase | F5 눌렀을 때 확인할 것 |
|-------|---------------------|
| **Phase 1** | Activity Bar에 🐱 아이콘 보임, 클릭하면 빈 TreeView, 커맨드 팔레트에서 "Tom Cattery" 검색됨 |
| **Phase 2** | "New Server" → 이름/경로 입력 → `~/.vscode/tom-cattery/servers/` 에 디렉토리 생성됨, TreeView에 서버 표시 |
| **Phase 3** | TreeView에서 ▶ Start → Tomcat 기동 → Output Channel에 로그 출력 → ⏹ Stop으로 정지 |
| **Phase 4** | Deploy → webapps/에 exploded 배포됨, 🐛 Debug → 브레이크포인트 잡힘 |

---

## 8. 학습 자료 (필요할 때 참고)

| 자료 | URL | 용도 |
|------|-----|------|
| **VSCode Extension API 공식 문서** | https://code.visualstudio.com/api | 전체 레퍼런스 |
| **Your First Extension** | https://code.visualstudio.com/api/get-started/your-first-extension | 5분 퀵스타트 |
| **TreeView Guide** | https://code.visualstudio.com/api/extension-guides/tree-view | 사이드바 구현 |
| **Webview Guide** | https://code.visualstudio.com/api/extension-guides/webview | 커스텀 UI |
| **Debug Extension Guide** | https://code.visualstudio.com/api/extension-guides/debugger-extension | 디버거 연동 |
| **Extension Samples (GitHub)** | https://github.com/microsoft/vscode-extension-samples | 예제 코드 모음 |
| **Publishing Extensions** | https://code.visualstudio.com/api/working-with-extensions/publishing-extension | Marketplace 배포 |

> 💡 Claude Code에서 작업할 때 이 URL들을 직접 참조하라고 지시할 수 있다.

---

## 9. 결론: 바로 Claude Code로 가도 된다

```mermaid
graph LR
    A["현재 상태<br/>설계 문서 완성"] -->|"✅ GO"| B["Claude Code에서<br/>Phase별 구현 시작"]
    
    A -->|"❌ 불필요"| C["설계 추가 고도화"]
    
    B --> B1["tom-cattery-design.md를<br/>프로젝트에 포함"]
    B --> B2["이 기술 가이드를<br/>CLAUDE.md에 포함"]
    B1 --> D["Phase 0부터 순차 진행"]
    B2 --> D
    
    style C fill:#fdd,stroke:#933
    style D fill:#dfd,stroke:#393
```

**추가 설계가 필요하지 않은 이유:**
- 아키텍처, 인터페이스, 워크플로우가 이미 충분히 상세
- 핵심 코드 스케치(DebugController, DeployManager)가 구현 가이드 역할
- 나머지 상세 사항은 구현하면서 결정하는 게 더 효율적
- VSCode Extension API는 잘 문서화되어 있어서 Claude Code가 참조 가능

**Claude Code에 넘길 파일:**
1. `tom-cattery-design.md` — 설계 전체
2. 이 문서 (`tom-cattery-techstack-guide.md`) — 기술 스택 & 작업 전략
