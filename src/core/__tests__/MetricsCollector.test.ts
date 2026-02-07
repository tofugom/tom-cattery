import { MetricsCollector } from '../MetricsCollector';

describe('MetricsCollector', () => {
  describe('formatUptime', () => {
    it('0초', () => {
      expect(MetricsCollector.formatUptime(0)).toBe('0초');
    });

    it('59초', () => {
      expect(MetricsCollector.formatUptime(59_000)).toBe('59초');
    });

    it('1분 (60초)', () => {
      expect(MetricsCollector.formatUptime(60_000)).toBe('1분');
    });

    it('1분 30초 → 1분 (초는 분 이상에서 표시 안 함)', () => {
      expect(MetricsCollector.formatUptime(90_000)).toBe('1분');
    });

    it('1시간', () => {
      expect(MetricsCollector.formatUptime(3_600_000)).toBe('1시간');
    });

    it('1시간 30분', () => {
      expect(MetricsCollector.formatUptime(5_400_000)).toBe('1시간 30분');
    });

    it('1일', () => {
      expect(MetricsCollector.formatUptime(86_400_000)).toBe('1일');
    });

    it('복합: 2일 3시간 15분', () => {
      const ms = (2 * 86400 + 3 * 3600 + 15 * 60) * 1000;
      expect(MetricsCollector.formatUptime(ms)).toBe('2일 3시간 15분');
    });

    it('500ms 미만은 0초', () => {
      expect(MetricsCollector.formatUptime(499)).toBe('0초');
    });
  });

  describe('formatMemoryMb', () => {
    it('0 KB → 0.0 MB', () => {
      expect(MetricsCollector.formatMemoryMb(0)).toBe('0.0 MB');
    });

    it('1024 KB → 1.0 MB', () => {
      expect(MetricsCollector.formatMemoryMb(1024)).toBe('1.0 MB');
    });

    it('소수점: 1536 KB → 1.5 MB', () => {
      expect(MetricsCollector.formatMemoryMb(1536)).toBe('1.5 MB');
    });

    it('큰 값: 524288 KB → 512.0 MB', () => {
      expect(MetricsCollector.formatMemoryMb(524288)).toBe('512.0 MB');
    });
  });
});
