// Everything the AI CLI keeps on disk lives in one folder, ~/.locci/ai (or
// LOCCI_AI_DIR), apart from the rest of ~/.locci, which other Locci tools use:
//
//   session.json          the login (auth.ts), owner-only
//   history.json          messages sent in the TUI, for Up (history.ts)
//   trusted-folders.json  folders allowed to run commands (trust.ts)
//   mcp.json              MCP servers, read by the example API when it has none
//   chats/                saved chats, for --continue and --resume (planned)

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const AI_DIR = process.env.LOCCI_AI_DIR || path.join(os.homedir(), '.locci', 'ai');

/** Where these files sat before ~/.locci/ai, moved on first use. */
const LEGACY: Record<string, string> = {
  'session.json': 'ai-chat-cli.json',
  'history.json': 'ai-chat-history.json',
  'trusted-folders.json': 'trusted-folders.json',
};

/** The path of `name` in AI_DIR, after moving an older copy from ~/.locci into it. */
export function aiFile(name: string): string {
  const file = path.join(AI_DIR, name);
  const old = LEGACY[name] && !process.env.LOCCI_AI_DIR ? path.join(os.homedir(), '.locci', LEGACY[name]) : null;
  if (old && existsSync(old) && !existsSync(file)) {
    try {
      mkdirSync(AI_DIR, { recursive: true, mode: 0o700 });
      renameSync(old, file);
    } catch {
      // Left where it was; the new file starts empty.
    }
  }
  return file;
}
