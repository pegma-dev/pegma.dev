import { describe, expect, it } from 'vitest';
import {
  knowledgeAdmissionCount,
  knowledgeAdmissionPolicyName,
} from './knowledge-admission';

describe('trusted knowledge admission configuration', () => {
  it('bounds explicit budgets while retaining the chosen default for absent configuration', () => {
    expect(knowledgeAdmissionCount(undefined, 120)).toBe(120);
    expect(knowledgeAdmissionCount('1', 120)).toBe(1);
    expect(knowledgeAdmissionCount(' 10000 ', 120)).toBe(10_000);
    for (const value of [
      '',
      '0',
      '-1',
      '1.5',
      '1e3',
      '01',
      '10001',
      'Infinity',
      '9'.repeat(17),
    ]) {
      expect(() => knowledgeAdmissionCount(value, 120)).toThrow(TypeError);
    }
  });

  it('uses a distinct immutable policy for a changed budget and reuses the original on rollback', () => {
    const initial = knowledgeAdmissionPolicyName('pegma.agent.resource', 300);
    expect(knowledgeAdmissionPolicyName('pegma.agent.resource', 600)).not.toBe(
      initial,
    );
    expect(knowledgeAdmissionPolicyName('pegma.agent.resource', 300)).toBe(
      initial,
    );
    for (const invalid of [0, -1, 1.5, 10_001, NaN, Infinity]) {
      expect(() =>
        knowledgeAdmissionPolicyName('pegma.agent.resource', invalid),
      ).toThrow(TypeError);
    }
  });
});
