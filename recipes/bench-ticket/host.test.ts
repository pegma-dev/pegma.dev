import { describe, expect, it } from 'vitest';
import { joinIncomingHeader, parseMailpitSmtpPort } from './host';
import { createMailpitSmtpProvider } from './mail-smtp';

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

describe('Mailpit SMTP port', () => {
  it('defaults to 1025 and accepts a valid integer', () => {
    expect(parseMailpitSmtpPort(undefined)).toBe(1025);
    expect(parseMailpitSmtpPort('1025')).toBe(1025);
  });

  it('refuses NaN and out-of-range values before connect', () => {
    expect(() => parseMailpitSmtpPort('notanumber')).toThrow(/MAILPIT_SMTP_PORT/);
    expect(() => parseMailpitSmtpPort('0')).toThrow(/MAILPIT_SMTP_PORT/);
    expect(() => createMailpitSmtpProvider({ host: '127.0.0.1', port: Number.NaN, from: 'x@y' })).toThrow(
      /Mailpit SMTP port/,
    );
  });
});

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
