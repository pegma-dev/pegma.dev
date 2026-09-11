/**
 * Console / log mail catcher for cloud runbooks. Safe on Workers.
 * Local Docker SMTP lives in `mail-smtp.ts` (Node `net`).
 */
import type { MailProvider, MailReconciliationPort } from '@pegma/mail';

export interface ConsoleMailOptions {
  readonly log?: (line: string) => void;
}

/** Logs subject + body. Cloud runbooks use this instead of a vendor. */
export function createConsoleMailProvider(
  options: ConsoleMailOptions = {},
): MailProvider {
  const log = options.log ?? ((line: string) => console.log(line));
  return {
    async send(request) {
      log(
        `[bench-ticket mail] to=${request.mail.recipient} subject=${request.mail.subject}`,
      );
      log(request.mail.text);
      return { providerMessageRef: `console:${request.idempotencyKey}` };
    },
  };
}

export function createCatcherReconciliation(): MailReconciliationPort {
  return {
    async reconcile() {
      return { status: 'delivered' };
    },
  };
}
