// Photos for the TUI: from a file dragged into the terminal (which pastes its
// path) or the clipboard (Ctrl+V). Sent as the AI SDK's image `file` parts, at
// most 1280 px on the long side like the web app (llama.cpp reads PNG and JPEG).

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_SIDE = 1280;
/** Without a resizer, what we send as is. */
const MAX_RAW_BYTES = 5 * 1024 * 1024;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|heic|heif|bmp|tiff?)$/i;

export interface ImageAttachment {
  n: number;
  name: string;
  mediaType: 'image/png' | 'image/jpeg';
  /** base64 */
  data: string;
}

/**
 * The image files a paste names, or null when it is not only image paths.
 * Terminals paste a dropped file as its path, quoted or with `\ ` for spaces,
 * several separated by spaces or new lines.
 */
export function imagePaths(pasted: string, cwd: string): string[] | null {
  // Any text can be pasted: only a few words, each ending in an image
  // extension, are worth checking on disk.
  if (pasted.length > 4096) return null;
  const tokens = pasted.trim().match(/'[^']+'|"[^"]+"|(?:\\.|[^\s\\])+/g);
  if (!tokens?.length || tokens.length > 20) return null;
  const files: string[] = [];
  for (const t of tokens) {
    const unquoted = /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t.replace(/\\(.)/g, '$1');
    if (!IMAGE_FILE.test(unquoted)) return null;
    let expanded = unquoted.replace(/^file:\/\//, '').replace(/^~(?=\/)/, os.homedir());
    try {
      // file:// paths come percent-encoded; a stray % ("50%") must not throw.
      expanded = decodeURI(expanded);
    } catch {
      // keep it as typed
    }
    const file = path.resolve(cwd, expanded);
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    files.push(file);
  }
  return files;
}

/** Read an image, converted to JPEG and shrunk with macOS `sips` when it is there. */
export async function loadImage(file: string): Promise<Omit<ImageAttachment, 'n'>> {
  const name = path.basename(file);
  if (process.platform === 'darwin') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'locci-img-'));
    try {
      const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
      const sides = [...stdout.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1]));
      const out = path.join(dir, 'image.jpg');
      const shrink = Math.max(...sides) > MAX_SIDE ? ['-Z', String(MAX_SIDE)] : [];
      await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', ...shrink, file, '--out', out]);
      return { name, mediaType: 'image/jpeg', data: (await readFile(out)).toString('base64') };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const mediaType = /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : null;
  if (!mediaType) throw new Error(`${name}: only PNG and JPEG are supported here`);
  const bytes = await readFile(file);
  if (bytes.length > MAX_RAW_BYTES) throw new Error(`${name} is over 5 MB`);
  return { name, mediaType, data: bytes.toString('base64') };
}

/**
 * The clipboard's image, saved to a temporary PNG, or null when it holds none.
 * macOS through AppleScript; Linux through wl-paste or xclip if installed.
 */
export async function clipboardImage(): Promise<{ file: string; cleanup: () => Promise<void> } | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'locci-clip-'));
  const file = path.join(dir, 'clipboard.png');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    if (process.platform === 'darwin') {
      await run('osascript', [
        '-e', `set f to (open for access POSIX file "${file}" with write permission)`,
        '-e', 'try',
        '-e', 'write (the clipboard as «class PNGf») to f',
        '-e', 'on error e',
        '-e', 'close access f',
        '-e', 'error e',
        '-e', 'end try',
        '-e', 'close access f',
      ]);
    } else if (process.platform === 'linux') {
      const sh = `wl-paste --type image/png > '${file}' 2>/dev/null || xclip -selection clipboard -t image/png -o > '${file}'`;
      await run('sh', ['-c', sh]);
    } else {
      await cleanup();
      return null;
    }
    if (!existsSync(file) || statSync(file).size === 0) throw new Error('empty');
    return { file, cleanup };
  } catch {
    await cleanup();
    return null;
  }
}
