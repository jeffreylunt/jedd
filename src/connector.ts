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
   * ⚠️ Both are contractually incapable of breaking a turn. `markRead` hands
   * back a plain boolean — NOT a promise, so there is still nothing to await
   * and nothing to reject. `withTyping` is transparent: it returns exactly what
   * `fn` returns and rethrows exactly what `fn` throws, and any failure of its
   * own is swallowed inside.
   *
   * 🔴 THE RETURN VALUE AND `onTyping` ARE THE ONLY HONEST WITNESS THAT A
   * SIGNAL WENT OUT. `Presence.report()` returns early on success, so a
   * successful call and a call that was never made are byte-identical in the
   * log — that is how a turn silently lost its read receipt and nobody could
   * tell. These report from INSIDE the gate that makes the decision, rather
   * than from a predicate somewhere else that re-derives it and drifts.
   */
  markRead(toHandle: string): boolean;
  withTyping<T>(toHandle: string, fn: () => Promise<T>, onTyping?: () => void): Promise<T>;
}

/** What a turn actually put on the wire, for the per-turn log line. */
export interface PresenceRecord {
  signalled: ('read' | 'typing')[];
}

/** How `PresenceRecord` reads in a log line. `none` is a real answer, not a gap. */
export function presenceToken(record: PresenceRecord): string {
  return record.signalled.length ? record.signalled.join('+') : 'none';
}

/**
 * Run one turn with both presence signals attached.
 *
 * 🔴 THE TWO CALLS ARE ONE CALL SO THAT HALF OF THEM CANNOT BE FORGOTTEN.
 *
 * `markRead` and `withTyping` always belong together at exactly one place — the
 * moment Jedd picks a message up — and there are two entry points that do it
 * (`main.ts` and `index.ts`). Left as two lines in each, they are two places to
 * drift, and the drift is silent: a turn missing its read receipt still answers
 * perfectly and nothing anywhere reports the omission.
 *
 * ⚠️ It also gives the tests something real to hold. A test that re-types the
 * handler proves the *shape* is possible, not that the shipped loop does it —
 * this is the function both the loop and the test call.
 *
 * Transparent: `turn`'s value and its exceptions pass straight through.
 */
export async function withPresence<T>(
  connector: Connector,
  message: IncomingMessage,
  turn: () => Promise<T>,
  record?: PresenceRecord,
): Promise<T> {
  // Not awaited, and it hands back a boolean rather than a promise so it cannot
  // be. The read receipt goes out as Jedd picks the message up, not after it has
  // thought about it.
  if (connector.markRead(message.senderHandle)) record?.signalled.push('read');
  return connector.withTyping(message.senderHandle, turn, () => record?.signalled.push('typing'));
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
  markRead(_toHandle: string): boolean {
    return false;
  }

  /**
   * A terminal has no typing indicator either — but it DOES have the long wait,
   * so this prints the one thing the indicator is for: evidence that the turn
   * started. It is deliberately transparent, so `fn`'s value and its exceptions
   * are untouched.
   */
  async withTyping<T>(_toHandle: string, fn: () => Promise<T>, onTyping?: () => void): Promise<T> {
    process.stdout.write('(thinking…)\n');
    onTyping?.();
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

  markRead(toHandle: string): boolean {
    this.presence.push({ event: 'read', to: toHandle });
    return true;
  }

  async withTyping<T>(toHandle: string, fn: () => Promise<T>, onTyping?: () => void): Promise<T> {
    this.presence.push({ event: 'typing-start', to: toHandle });
    onTyping?.();
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
