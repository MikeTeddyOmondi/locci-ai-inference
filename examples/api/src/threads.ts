import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UIMessage } from 'ai';

// Server-side thread persistence, mirroring autonomous-chatbot's Drizzle schema
// (threads + messages) and its threads.ts operations, on libSQL. The web
// example keeps threads in the browser (IndexedDB) by default; this store is
// the plumbing for moving them server-side. Enable with THREAD_STORE=libsql.
// Every thread has an owner (the signed-in user's id, '' with AUTH=off) and a
// store from forOwner() only ever sees its owner's threads and messages.

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

/** A thread matching a search, with the matching text around the hit. */
export interface ThreadHit {
  id: string;
  snippet: string;
}

/** What the web example's storage adapter needs; any backend can implement it. */
export interface ThreadStore {
  list(): Promise<Thread[]>;
  get(id: string): Promise<ThreadWithMessages | null>;
  create(data?: { title?: string; preview?: string }): Promise<Thread>;
  update(id: string, patch: ThreadPatch): Promise<Thread | null>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  /** False when the thread does not exist for this owner. */
  syncMessages(id: string, messages: UIMessage[]): Promise<boolean>;
  /** Threads whose title or any message contains `query` (case-insensitive), best first. */
  search(query: string): Promise<ThreadHit[]>;
  /**
   * Add a thread made elsewhere (the web app moving chats a browser kept before
   * sign-in), keeping its id, title, pin and dates. 'exists' if this owner has
   * it already, 'taken' if the id belongs to someone else.
   */
  importThread(thread: ThreadWithMessages): Promise<'imported' | 'exists' | 'taken'>;
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

/** Columns added after the first release, created on databases that predate them. */
const MIGRATIONS: { table: string; column: string; sql: string }[] = [
  { table: 'threads', column: 'owner', sql: `ALTER TABLE threads ADD COLUMN owner TEXT NOT NULL DEFAULT ''` },
];
const INDEXES = [`CREATE INDEX IF NOT EXISTS threads_owner ON threads(owner, starred, updated_at)`];

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

/** All of a message's text, pasted attachments included (without their tags): what search looks in. */
function allTextOf(message: UIMessage): string {
  return (message.parts ?? [])
    .map((p) => (p.type === 'text' && 'text' in p ? p.text : ''))
    .join(' ')
    .replace(/<\/?attachment[^>]*>/g, ' ');
}

const SNIPPET_BEFORE = 12;
const SNIPPET_AFTER = 90;

/** The text around the first match of `needle` (lowercase), or '' when there is none. */
function snippetAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at === -1) return '';
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(flat.length, at + needle.length + SNIPPET_AFTER);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** Escape LIKE wildcards so a search for "100%" means the text "100%". */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class LibsqlThreadStore implements ThreadStore {
  constructor(
    private db: Client,
    private ready: Promise<void> = migrate(db),
    private owner = '',
  ) {}

  /** The same database, seen as one owner's threads. */
  forOwner(owner: string): LibsqlThreadStore {
    return new LibsqlThreadStore(this.db, this.ready, owner);
  }

  /** Whether the thread exists and belongs to this store's owner. */
  private async owns(id: string): Promise<boolean> {
    const rs = await this.db.execute({ sql: 'SELECT 1 FROM threads WHERE id = ? AND owner = ?', args: [id, this.owner] });
    return rs.rows.length > 0;
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
    const rs = await this.db.execute({
      sql: 'SELECT * FROM threads WHERE owner = ? ORDER BY starred DESC, updated_at DESC',
      args: [this.owner],
    });
    return rs.rows.map((r) => toThread(r as Row));
  }

  async get(id: string): Promise<ThreadWithMessages | null> {
    await this.ready;
    const t = await this.db.execute({ sql: 'SELECT * FROM threads WHERE id = ? AND owner = ?', args: [id, this.owner] });
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
      sql: 'INSERT INTO threads (id, owner, title, preview, starred, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      args: [id, this.owner, data.title ?? '', data.preview ?? '', now, now],
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
    await this.db.execute({
      sql: `UPDATE threads SET ${sets.join(', ')} WHERE id = ? AND owner = ?`,
      args: [...args, id, this.owner],
    });
    const rs = await this.db.execute({ sql: 'SELECT * FROM threads WHERE id = ? AND owner = ?', args: [id, this.owner] });
    return rs.rows[0] ? toThread(rs.rows[0] as Row) : null;
  }

  async importThread(thread: ThreadWithMessages): Promise<'imported' | 'exists' | 'taken'> {
    await this.ready;
    const found = await this.db.execute({ sql: 'SELECT owner FROM threads WHERE id = ?', args: [thread.id] });
    if (found.rows.length > 0) return String(found.rows[0].owner) === this.owner ? 'exists' : 'taken';
    const now = new Date().toISOString();
    const createdAt = thread.createdAt || now;
    await this.db.batch(
      [
        {
          sql: 'INSERT INTO threads (id, owner, title, preview, starred, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [thread.id, this.owner, thread.title ?? '', thread.preview ?? '', thread.starred ? 1 : 0, createdAt, thread.updatedAt || createdAt],
        },
        ...(thread.messages ?? []).map((msg, position) => ({
          sql: 'INSERT INTO messages (id, thread_id, position, role, content, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [msg.id, thread.id, position, msg.role, allTextOf(msg), JSON.stringify(msg.parts ?? []), createdAt],
        })),
      ],
      'write',
    );
    return 'imported';
  }

  async remove(id: string): Promise<void> {
    await this.ready;
    await this.db.execute({ sql: 'DELETE FROM threads WHERE id = ? AND owner = ?', args: [id, this.owner] });
  }

  async clear(): Promise<void> {
    await this.ready;
    await this.db.execute({ sql: 'DELETE FROM threads WHERE owner = ?', args: [this.owner] });
  }

  /** Replace a thread's messages, as autonomous-chatbot's syncThreadMessages. False if the thread is not this owner's. */
  async syncMessages(id: string, messages: UIMessage[]): Promise<boolean> {
    await this.ready;
    if (!(await this.owns(id))) return false;
    const now = new Date().toISOString();
    const stmts = [
      { sql: 'DELETE FROM messages WHERE thread_id = ?', args: [id] },
      ...messages.map((msg, position) => ({
        sql: 'INSERT INTO messages (id, thread_id, position, role, content, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [msg.id, id, position, msg.role, allTextOf(msg), JSON.stringify(msg.parts ?? []), now],
      })),
    ];
    const firstUser = messages.find((m) => m.role === 'user');
    stmts.push({
      sql: 'UPDATE threads SET updated_at = ?, preview = COALESCE(?, preview) WHERE id = ?',
      args: [now, firstUser ? textOf(firstUser).substring(0, 100) : null, id] as never,
    });
    await this.db.batch(stmts, 'write');
    return true;
  }

  /** LIKE is case-insensitive for ASCII in SQLite; the snippet comes from the first matching message. */
  async search(query: string): Promise<ThreadHit[]> {
    await this.ready;
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const pattern = likePattern(needle);
    const rs = await this.db.execute({
      sql: `SELECT t.id AS id, (t.title LIKE ?1 ESCAPE '\\' OR t.preview LIKE ?1 ESCAPE '\\') AS in_title, m.content AS content
            FROM threads t
            LEFT JOIN messages m ON m.thread_id = t.id AND m.content LIKE ?1 ESCAPE '\\'
            WHERE t.owner = ?2 AND (t.title LIKE ?1 ESCAPE '\\' OR t.preview LIKE ?1 ESCAPE '\\' OR m.id IS NOT NULL)
            ORDER BY t.starred DESC, t.updated_at DESC, m.position`,
      args: [pattern, this.owner],
    });
    const hits = new Map<string, ThreadHit>();
    for (const r of rs.rows) {
      const id = String(r.id);
      if (hits.has(id)) continue;
      hits.set(id, { id, snippet: Number(r.in_title) ? '' : snippetAround(String(r.content ?? ''), needle) });
    }
    return [...hits.values()];
  }
}

async function migrate(db: Client): Promise<void> {
  await db.execute('PRAGMA foreign_keys = ON');
  for (const sql of SCHEMA) await db.execute(sql);
  for (const { table, column, sql } of MIGRATIONS) {
    const columns = await db.execute(`PRAGMA table_info(${table})`);
    if (!columns.rows.some((r) => r.name === column)) await db.execute(sql);
  }
  for (const sql of INDEXES) await db.execute(sql);
}
