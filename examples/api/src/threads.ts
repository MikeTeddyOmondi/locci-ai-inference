import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UIMessage } from 'ai';

// Server-side thread persistence, mirroring autonomous-chatbot's Drizzle schema
// (threads + messages) and its threads.ts operations, on libSQL. The web
// example keeps threads in the browser (IndexedDB) by default; this store is
// the plumbing for moving them server-side. Enable with THREAD_STORE=libsql.

export interface Thread {
  id: string;
  title: string;
  preview: string;
  starred: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export interface ThreadWithMessages extends Thread {
  messages: UIMessage[];
}

export type ThreadPatch = Partial<Pick<Thread, 'title' | 'preview' | 'starred'>>;

/** What the web example's storage adapter needs; any backend can implement it. */
export interface ThreadStore {
  list(): Promise<Thread[]>;
  get(id: string): Promise<ThreadWithMessages | null>;
  create(data?: { title?: string; preview?: string }): Promise<Thread>;
  update(id: string, patch: ThreadPatch): Promise<Thread | null>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  syncMessages(id: string, messages: UIMessage[]): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS threads (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL DEFAULT '',
     preview TEXT NOT NULL DEFAULT '',
     starred INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
     content TEXT NOT NULL,
     parts TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, position)`,
];

type Row = Record<string, unknown>;

const toThread = (r: Row): Thread => ({
  id: String(r.id),
  title: String(r.title ?? ''),
  preview: String(r.preview ?? ''),
  starred: Number(r.starred) === 1,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

/** First text part of a message, as autonomous-chatbot's getMessageContent. */
function textOf(message: UIMessage): string {
  const part = message.parts?.find((p) => p.type === 'text');
  return part && 'text' in part ? part.text : '';
}

export class LibsqlThreadStore implements ThreadStore {
  private ready: Promise<void>;

  constructor(private db: Client) {
    this.ready = (async () => {
      await db.execute('PRAGMA foreign_keys = ON');
      for (const sql of SCHEMA) await db.execute(sql);
    })();
  }

  /** url defaults to a file next to the API: file:./data/threads.db */
  static open(url = process.env.THREADS_DB_URL ?? 'file:./data/threads.db'): LibsqlThreadStore {
    if (url.startsWith('file:')) {
      fs.mkdirSync(path.dirname(path.resolve(url.slice('file:'.length))), { recursive: true });
    }
    return new LibsqlThreadStore(createClient({ url, authToken: process.env.THREADS_DB_AUTH_TOKEN }));
  }

  async list(): Promise<Thread[]> {
    await this.ready;
    const rs = await this.db.execute('SELECT * FROM threads ORDER BY starred DESC, updated_at DESC');
    return rs.rows.map((r) => toThread(r as Row));
  }

  async get(id: string): Promise<ThreadWithMessages | null> {
    await this.ready;
    const t = await this.db.execute({ sql: 'SELECT * FROM threads WHERE id = ?', args: [id] });
    if (t.rows.length === 0) return null;
    const m = await this.db.execute({
      sql: 'SELECT * FROM messages WHERE thread_id = ? ORDER BY position',
      args: [id],
    });
    const messages = m.rows.map((r) => ({
      id: String(r.id),
      role: String(r.role),
      parts: JSON.parse(String(r.parts)),
    })) as UIMessage[];
    return { ...toThread(t.rows[0] as Row), messages };
  }

  async create(data: { title?: string; preview?: string } = {}): Promise<Thread> {
    await this.ready;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.db.execute({
      sql: 'INSERT INTO threads (id, title, preview, starred, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
      args: [id, data.title ?? '', data.preview ?? '', now, now],
    });
    return { id, title: data.title ?? '', preview: data.preview ?? '', starred: false, createdAt: now, updatedAt: now };
  }

  async update(id: string, patch: ThreadPatch): Promise<Thread | null> {
    await this.ready;
    const sets: string[] = ['updated_at = ?'];
    const args: (string | number)[] = [new Date().toISOString()];
    if (patch.title !== undefined) (sets.push('title = ?'), args.push(patch.title));
    if (patch.preview !== undefined) (sets.push('preview = ?'), args.push(patch.preview));
    if (patch.starred !== undefined) (sets.push('starred = ?'), args.push(patch.starred ? 1 : 0));
    await this.db.execute({ sql: `UPDATE threads SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
    const rs = await this.db.execute({ sql: 'SELECT * FROM threads WHERE id = ?', args: [id] });
    return rs.rows[0] ? toThread(rs.rows[0] as Row) : null;
  }

  async remove(id: string): Promise<void> {
    await this.ready;
    await this.db.execute({ sql: 'DELETE FROM threads WHERE id = ?', args: [id] });
  }

  async clear(): Promise<void> {
    await this.ready;
    await this.db.execute('DELETE FROM threads');
  }

  /** Replace a thread's messages, as autonomous-chatbot's syncThreadMessages. */
  async syncMessages(id: string, messages: UIMessage[]): Promise<void> {
    await this.ready;
    const now = new Date().toISOString();
    const stmts = [
      { sql: 'DELETE FROM messages WHERE thread_id = ?', args: [id] },
      ...messages.map((msg, position) => ({
        sql: 'INSERT INTO messages (id, thread_id, position, role, content, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [msg.id, id, position, msg.role, textOf(msg), JSON.stringify(msg.parts ?? []), now],
      })),
    ];
    const firstUser = messages.find((m) => m.role === 'user');
    stmts.push({
      sql: 'UPDATE threads SET updated_at = ?, preview = COALESCE(?, preview) WHERE id = ?',
      args: [now, firstUser ? textOf(firstUser).substring(0, 100) : null, id] as never,
    });
    await this.db.batch(stmts, 'write');
  }
}
