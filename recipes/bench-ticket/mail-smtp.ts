/**
 * Mailpit SMTP catcher for Local Docker. Node-only (`node:net`).
 */
import { connect } from 'node:net';
import type { MailProvider } from '@pegma/mail';

export interface MailpitSmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly from: string;
}

function headerSafe(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ');
}

function smtpDialog(
  host: string,
  port: number,
  lines: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = '';
    const pending = [...lines];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Mailpit SMTP timed out'));
    }, 8_000);

    function fail(error: unknown): void {
      clearTimeout(timer);
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    socket.setEncoding('utf8');
    socket.on('error', fail);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const idx = buffer.indexOf('\n');
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const code = Number.parseInt(line.slice(0, 3), 10);
        if (!Number.isInteger(code) || line[3] === '-') {
          continue;
        }
        if (code >= 400) {
          fail(new Error(`Mailpit SMTP ${line}`));
          return;
        }
        if (pending.length === 0) {
          clearTimeout(timer);
          socket.end();
          resolve('mailpit');
          return;
        }
        const next = pending.shift();
        if (next === undefined) {
          return;
        }
        socket.write(next.endsWith('\r\n') ? next : `${next}\r\n`);
      }
    });
  });
}

/**
 * Sends Identity mail through Mailpit’s unauthenticated SMTP. Honors the
 * provider idempotency key as a Message-ID local part.
 */
export function createMailpitSmtpProvider(
  options: MailpitSmtpOptions,
): MailProvider {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('Mailpit SMTP port must be an integer 1–65535');
  }
  return {
    async send(request) {
      const subject = headerSafe(request.mail.subject);
      const from = headerSafe(options.from);
      const to = headerSafe(request.mail.recipient);
      const id = request.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '');
      const body = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Message-ID: <${id}@bench-ticket.local>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        request.mail.text,
        '',
      ].join('\r\n');
      await smtpDialog(options.host, options.port, [
        'EHLO bench-ticket',
        `MAIL FROM:<${from}>`,
        `RCPT TO:<${to}>`,
        'DATA',
        `${body}\r\n.`,
        'QUIT',
      ]);
      return { providerMessageRef: `mailpit:${id}` };
    },
  };
}
