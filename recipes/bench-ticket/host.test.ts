import { describe, expect, it } from 'vitest';
import { joinIncomingHeader } from './host';

describe('Node incoming headers', () => {
  it('joins Cookie arrays with "; "', () => {
    expect(joinIncomingHeader('cookie', ['a=1', 'b=2'])).toBe('a=1; b=2');
    expect(joinIncomingHeader('Cookie', ['bench_ticket_session=abc', 'other=1'])).toBe(
      'bench_ticket_session=abc; other=1',
    );
  });

  it('joins other multi-value headers with ", "', () => {
    expect(joinIncomingHeader('accept', ['text/html', 'application/json'])).toBe(
      'text/html, application/json',
    );
  });

  it('leaves a single header value unchanged', () => {
    expect(joinIncomingHeader('cookie', 'a=1')).toBe('a=1');
  });
});
