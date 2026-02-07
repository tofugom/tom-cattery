/**
 * DeployManager.contextPathToDir() 테스트
 *
 * DeployManager는 vscode 모듈에 의존하므로 모킹이 필요하다.
 * contextPathToDir()는 순수 문자열 변환 함수.
 */

// vscode 모듈 모킹
jest.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined, createFileSystemWatcher: jest.fn(), onDidSaveTextDocument: jest.fn() },
  window: { withProgress: jest.fn(), showInformationMessage: jest.fn() },
  tasks: { executeTask: jest.fn() },
  Uri: { file: jest.fn() },
  RelativePattern: jest.fn(),
  ProgressLocation: { Notification: 15 },
  TaskScope: { Workspace: 2 },
  Task: jest.fn(),
  ShellExecution: jest.fn(),
}), { virtual: true });

// adm-zip 모킹
jest.mock('adm-zip', () => jest.fn(), { virtual: true });

import { DeployManager } from '../DeployManager';

describe('DeployManager', () => {
  const deployManager = new DeployManager();

  describe('contextPathToDir', () => {
    it('/ → ROOT', () => {
      expect(deployManager.contextPathToDir('/')).toBe('ROOT');
    });

    it('빈 문자열 → ROOT', () => {
      expect(deployManager.contextPathToDir('')).toBe('ROOT');
    });

    it('/api → api', () => {
      expect(deployManager.contextPathToDir('/api')).toBe('api');
    });

    it('/app/v2 → app#v2', () => {
      expect(deployManager.contextPathToDir('/app/v2')).toBe('app#v2');
    });

    it('/deep/nested/path → deep#nested#path', () => {
      expect(deployManager.contextPathToDir('/deep/nested/path')).toBe('deep#nested#path');
    });

    it('선행 슬래시 없는 경우: api → api', () => {
      expect(deployManager.contextPathToDir('api')).toBe('api');
    });
  });
});
