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
