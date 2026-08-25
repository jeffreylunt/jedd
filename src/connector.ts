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

  /**
   * ── PRESENCE: the two things a transport can say without saying anything ───
   *
   * 🔴 REQUIRED, NOT OPTIONAL, AND THE NO-OP HAS TO BE TYPED OUT.
   *
   * These could have been `markRead?:` and let three of the four connectors
   * ignore them. They are not, for the same reason `JEDD_SEND_TO` has no
   * default: an author who has not thought about it should not get an answer by
   * forgetting. A transport that cannot show typing writes the no-op and says so
   * — which is a decision — rather than silently inheriting one.
   *
   * ⚠️ Both are contractually incapable of breaking a turn. `markRead` returns
   * `void`, so there is no promise to await and nothing to reject. `withTyping`
   * is transparent: it returns exactly what `fn` returns and rethrows exactly
   * what `fn` throws, and any failure of its own is swallowed inside.
   */
  markRead(toHandle: string): void;
  withTyping<T>(toHandle: string, fn: () => Promise<T>): Promise<T>;
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

  /** A terminal has no read receipts. Nothing to do, said out loud. */
  markRead(): void {}

  /**
   * A terminal has no typing indicator either — but it DOES have the long wait,
   * so this prints the one thing the indicator is for: evidence that the turn
   * started. It is deliberately transparent, so `fn`'s value and its exceptions
   * are untouched.
   */
  async withTyping<T>(_toHandle: string, fn: () => Promise<T>): Promise<T> {
    process.stdout.write('(thinking…)\n');
    return fn();
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
  /** Ordered presence events, so a test can assert start/stop ORDER, not just counts. */
  readonly presence: { event: 'read' | 'typing-start' | 'typing-stop'; to: string }[] = [];

  constructor(private readonly script: IncomingMessage[] = []) {}

  async send(toHandle: string, text: string): Promise<void> {
    this.sent.push({ to: toHandle, text });
  }

  markRead(toHandle: string): void {
    this.presence.push({ event: 'read', to: toHandle });
  }

  async withTyping<T>(toHandle: string, fn: () => Promise<T>): Promise<T> {
    this.presence.push({ event: 'typing-start', to: toHandle });
    try {
      return await fn();
    } finally {
      this.presence.push({ event: 'typing-stop', to: toHandle });
    }
  }

  async listen(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    for (const message of this.script) await handler(message);
  }
}
