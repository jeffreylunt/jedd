import { createInterface } from 'node:readline';

export interface IncomingMessage {
  /** Whatever the transport calls the sender: a phone number, an email, a handle. */
  senderHandle: string;
  text: string;
}

/**
 * The transport seam. Nothing above this interface knows whether it is talking
 * to iMessage, a terminal, or a test. BlueBubbles slots in here later without
 * the loop changing.
 */
export interface Connector {
  readonly name: string;
  send(toHandle: string, text: string): Promise<void>;
  /** Begin delivering messages. Resolves when the source is exhausted. */
  listen(handler: (message: IncomingMessage) => Promise<void>): Promise<void>;
}

/**
 * Terminal connector. Lines typed on stdin arrive as messages from
 * `defaultSender`; replies print to stdout.
 *
 * `sender:<handle>` switches who you are speaking as — that is how the
 * permission boundary gets exercised by hand.
 */
export class StdoutConnector implements Connector {
  readonly name = 'stdout';
  private currentSender: string;

  constructor(defaultSender: string) {
    this.currentSender = defaultSender;
  }

  async send(toHandle: string, text: string): Promise<void> {
    console.log(`\n[jedd → ${toHandle}]\n${text}\n`);
  }

  async listen(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    console.log(
      `Jedd V2. You are "${this.currentSender}". ` +
        'Type `sender:<handle>` to switch identity, `exit` to quit.\n',
    );
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      if (text === 'exit' || text === 'quit') break;
      if (text.startsWith('sender:')) {
        this.currentSender = text.slice('sender:'.length).trim();
        console.log(`(now speaking as ${this.currentSender})`);
        continue;
      }
      await handler({ senderHandle: this.currentSender, text });
    }
  }
}

/** Connector for tests: scripted input, captured output. */
export class TestConnector implements Connector {
  readonly name = 'test';
  readonly sent: { to: string; text: string }[] = [];

  constructor(private readonly script: IncomingMessage[] = []) {}

  async send(toHandle: string, text: string): Promise<void> {
    this.sent.push({ to: toHandle, text });
  }

  async listen(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    for (const message of this.script) await handler(message);
  }
}
