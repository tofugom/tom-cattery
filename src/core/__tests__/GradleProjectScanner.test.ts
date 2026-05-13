import { GradleProjectScanner } from '../GradleProjectScanner';

describe('GradleProjectScanner', () => {
  const scanner = new GradleProjectScanner();

  describe('parseIncludeStatements', () => {
    it('단일 include 파싱', () => {
      const content = `include ':web-app'`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['web-app']);
    });

    it('복수 include 파싱', () => {
      const content = `include ':web-app', ':api-server', ':admin-console'`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['web-app', 'api-server', 'admin-console']);
    });

    it('Kotlin DSL 스타일 (괄호 + 쌍따옴표)', () => {
      const content = `include(":web-app")`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['web-app']);
    });

    it('Kotlin DSL 복수 include', () => {
      const content = `include(":web-app", ":api-server")`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['web-app', 'api-server']);
    });

    it('중첩 모듈 (shared:common)', () => {
      const content = `include ':shared:common', ':web-app'`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['shared:common', 'web-app']);
    });

    it('여러 줄에 걸친 include', () => {
      const content = `
include ':web-app'
include ':api-server'
`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['web-app', 'api-server']);
    });

    it('include가 없는 경우 빈 배열 반환', () => {
      const content = `
rootProject.name = 'my-project'
`;
      expect(scanner.parseIncludeStatements(content)).toEqual([]);
    });

    it(': prefix 없는 모듈명도 파싱', () => {
      const content = `include 'web-app', 'api-server'`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['web-app', 'api-server']);
    });

    it(': prefix 있는/없는 혼합 모듈명 파싱', () => {
      const content = `include ':web-app', 'api-server'`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['web-app', 'api-server']);
    });

    it('다중 라인 include (콤마 후 줄바꿈) 파싱', () => {
      const content = `
include ':web-app',
        ':api-server',
        ':admin-console'
`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['web-app', 'api-server', 'admin-console']);
    });

    it('라인 주석 안의 include는 무시', () => {
      const content = `
// include ':commented-out'
include ':real-module'
`;
      expect(scanner.parseIncludeStatements(content)).toEqual(['real-module']);
    });
  });

  describe('appliesWarToChildren', () => {
    it('subprojects {} 안의 war 플러그인 감지', () => {
      const content = `
subprojects {
  apply plugin: 'java'
  apply plugin: 'war'
}`;
      expect(scanner.appliesWarToChildren(content)).toBe(true);
    });

    it('allprojects {} 안의 id("war") 감지 (Kotlin DSL)', () => {
      const content = `
allprojects {
  plugins {
    id("war")
  }
}`;
      expect(scanner.appliesWarToChildren(content)).toBe(true);
    });

    it('블록 밖의 war 플러그인은 false (자식 적용 아님)', () => {
      const content = `
plugins {
  id 'war'
}
subprojects {
  apply plugin: 'java'
}`;
      expect(scanner.appliesWarToChildren(content)).toBe(false);
    });

    it('블록이 없으면 false', () => {
      const content = `
plugins {
  id 'java'
}`;
      expect(scanner.appliesWarToChildren(content)).toBe(false);
    });

    it('configure(subprojects) {} 패턴 감지', () => {
      const content = `
configure(subprojects) {
  apply plugin: 'war'
}`;
      expect(scanner.appliesWarToChildren(content)).toBe(true);
    });

    it('configure(subprojects.findAll {...}) {} 패턴 감지 (실제 DevOn Enterprise 형태)', () => {
      const content = `
configure(subprojects.findAll({
        it.name.find('devon-enterprise-idemgt') || it.name.find('devon-enterprise-prototype')
        || it.name.find('devon-enterprise-logagent')
        || it.name == 'management6'
    })) {
        apply plugin: 'war'

        eclipse {
           wtp {
               facet {
                   facet name: 'jst.web' , version: '4.0'
               }
           }
        }
}`;
      expect(scanner.appliesWarToChildren(content)).toBe(true);
    });

    it('configure(project(":a")) {} 패턴 감지', () => {
      const content = `
configure(project(':web-app')) {
  apply plugin: 'war'
}`;
      expect(scanner.appliesWarToChildren(content)).toBe(true);
    });

    it('configure(something_unrelated) 안의 war 는 무시', () => {
      const content = `
configure(extensions.findByName('foo')) {
  apply plugin: 'war'
}`;
      expect(scanner.appliesWarToChildren(content)).toBe(false);
    });
  });

  describe('containsPlugin (일반화)', () => {
    it('Spring Boot 플러그인 감지 (dot id)', () => {
      const content = `
plugins {
  id 'org.springframework.boot' version '3.2.0'
  id 'io.spring.dependency-management' version '1.1.4'
  id 'war'
}`;
      expect(scanner.containsPlugin(content, 'org.springframework.boot')).toBe(true);
      expect(scanner.containsPlugin(content, 'war')).toBe(true);
    });

    it('Kotlin DSL 의 Spring Boot 감지', () => {
      const content = `
plugins {
  id("org.springframework.boot") version "3.2.0"
}`;
      expect(scanner.containsPlugin(content, 'org.springframework.boot')).toBe(true);
    });

    it('appliesPluginToChildren 으로 Spring Boot 일괄 적용 감지', () => {
      const content = `
configure(subprojects.findAll { it.name.startsWith('svc-') }) {
  apply plugin: 'org.springframework.boot'
  apply plugin: 'war'
}`;
      expect(scanner.appliesPluginToChildren(content, 'org.springframework.boot')).toBe(true);
      expect(scanner.appliesPluginToChildren(content, 'war')).toBe(true);
    });
  });

  describe('containsWarPlugin', () => {
    it('Groovy: id \'war\'', () => {
      const content = `
plugins {
    id 'war'
    id 'java'
}`;
      expect(scanner.containsWarPlugin(content)).toBe(true);
    });

    it('Kotlin DSL: id("war")', () => {
      const content = `
plugins {
    id("war")
    id("java")
}`;
      expect(scanner.containsWarPlugin(content)).toBe(true);
    });

    it('레거시 apply plugin', () => {
      const content = `apply plugin: 'war'`;
      expect(scanner.containsWarPlugin(content)).toBe(true);
    });

    it('war 플러그인이 없는 경우', () => {
      const content = `
plugins {
    id 'java'
    id 'application'
}`;
      expect(scanner.containsWarPlugin(content)).toBe(false);
    });

    it('주석 안의 war는 감지하지 않아야 하지만 현재 regex는 감지함 (알려진 한계)', () => {
      // 현재 구현은 단순 regex이므로 주석 내부도 감지한다
      const content = `// id 'war'`;
      // 이 테스트는 현재 동작을 문서화
      expect(scanner.containsWarPlugin(content)).toBe(true);
    });
  });
});
