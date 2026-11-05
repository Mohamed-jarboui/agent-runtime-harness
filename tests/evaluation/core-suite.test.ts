import { describe, expect, it } from 'vitest';
import { coreSuite, runTask } from '@loopsmith/evaluation';

describe('built-in benchmark suite (mock provider)', () => {
  for (const task of coreSuite) {
    it(`${task.id}: ${task.title}`, async () => {
      const result = await runTask(task);
      const failed = result.checks.filter((c) => !c.passed);
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
      expect(result.passed).toBe(true);
    });
  }
});
