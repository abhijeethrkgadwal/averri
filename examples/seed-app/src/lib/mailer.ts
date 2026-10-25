/**
 * Outbound email. `MemoryMailer` keeps an outbox for tests and local development; `ConsoleMailer`
 * prints. A real transport would implement the same interface.
 */
export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  template: string;
  data: Record<string, unknown>;
}

export interface Mailer {
  send(mail: OutboundMail): Promise<void>;
}

export class MemoryMailer implements Mailer {
  readonly outbox: OutboundMail[] = [];

  async send(mail: OutboundMail): Promise<void> {
    this.outbox.push(mail);
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

export class ConsoleMailer implements Mailer {
  async send(mail: OutboundMail): Promise<void> {
    console.log(`[mail] to=${mail.to} subject=${JSON.stringify(mail.subject)} template=${mail.template}`);
  }
}
