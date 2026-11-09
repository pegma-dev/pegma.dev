/** Trusted host configuration; these are shared IP budgets, not user quotas. */
export function knowledgeAdmissionCount(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (value.length > 16 || !/^[1-9][0-9]{0,4}$/u.test(value.trim())) {
    throw new TypeError('Invalid knowledge admission configuration.');
  }
  const limit = Number(value.trim());
  if (!Number.isSafeInteger(limit) || limit > 10_000) {
    throw new TypeError('Invalid knowledge admission configuration.');
  }
  return limit;
}

/** A changed immutable policy budget gets its own bounded, deterministic name. */
export function knowledgeAdmissionPolicyName(
  name: string,
  limit: number,
): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TypeError('Invalid knowledge admission configuration.');
  }
  return `${name}.v1.limit-${limit}`;
}
