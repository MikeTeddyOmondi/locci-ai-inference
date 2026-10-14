import 'dotenv/config';
import { createCliRenderer, type PasteEvent, type TextareaOptions, type TextareaRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from './markdown.js';
import {
  API,
  DECLINED_PREFIX,
  editPreview,
  parseThink,
  thinkFlag,
  THINK_NOTE,
  fetchModels,
  pickModel,
  runTurn,
  toolLabel,
  type Action,
  type ChatEvent,
  type ModelInfo,
  type Msg as ModelMsg,
  type ThinkSetting,
} from './agent.js';
import { clipboardImage, imagePaths, loadImage, type ImageAttachment } from './images.js';
import { loadHistory, remember } from './history.js';
import { runShell, userRanNote, type ShellResult } from './shell.js';
import { isTrusted, trust, TRUST_QUESTION } from './trust.js';

const SYSTEM = process.env.SYSTEM_PROMPT;
// Set by `locci-chat tui` (cli.ts): the shell tool, where it runs, and YOLO mode.
const SHELL = process.env.LOCCI_SHELL !== '0';
const CWD = process.env.LOCCI_CWD || process.cwd();
const YOLO = process.env.LOCCI_YOLO === '1';
/** Thinking: left to the API per model, unless `--no-think`; /think on|off|auto changes it. */
const THINK: ThinkSetting = process.env.LOCCI_THINK === '0' ? 'off' : 'auto';
// As in cli.ts: gemma-4-e2b unless LOCCI_MODEL says otherwise.
const MODEL = process.env.LOCCI_MODEL || 'gemma-4-e2b';
const CLIENT_TOOL_NAMES = new Set(['shell', 'read_file', 'write_file', 'edit_file']);

/** Composer height in text rows: it grows with the draft up to this. */
const MAX_COMPOSER_ROWS = 8;

/**
 * Enter sends; Ctrl+Enter, Cmd+Enter, Shift+Enter and Alt+Enter add a line
 * (the first three where the terminal reports them, through the kitty keyboard
 * protocol OpenTUI turns on), and Ctrl+J does in every terminal.
 */
const COMPOSER_KEYS: TextareaOptions['keyBindings'] = [
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  { name: 'return', ctrl: true, action: 'newline' },
  { name: 'return', super: true, action: 'newline' },
  { name: 'return', shift: true, action: 'newline' },
  { name: 'return', meta: true, action: 'newline' },
  { name: 'linefeed', action: 'newline' },
];

/** A paste this long or longer is held as a placeholder until it is sent. */
const PASTE_LINES = 2;
const PASTE_CHARS = 800;
const PASTE_TOKEN = /\[Pasted text #(\d+)[^\]]*\]/g;
const IMAGE_TOKEN = /\[Image #(\d+)\]/g;

/** Rows the draft takes in a composer `cols` wide, wrapped lines included, capped. */
function rowsFor(text: string, cols: number): number {
  const rows = text
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / Math.max(1, cols))), 0);
  return Math.min(MAX_COMPOSER_ROWS, Math.max(1, rows));
}
const VERSION = '0.1.0'; // keep in sync with the version in cli.ts

// Tokyo-night-ish palette, so the TUI reads the same in light and dark terminals.
const C = {
  accent: '#7aa2f7',
  logo: '#7aa2f7',
  logoDim: '#3b4261',
  user: '#ff9ec8', // pink accent gutter on a human turn
  agent: '#e0af68',
  dim: '#565f89',
  warn: '#f7768e',
  userBlock: '#26222e', // tint behind a human turn
  agentBlock: '#22252e', // neutral grey behind an agent turn
  panel: '#1f2335', // shared background for the composer + its command menu
  selected: '#2f3549', // highlighted row in the command menu
} as const;

/** A tool the model invoked, tracked from "input-start" through to its result. */
type ToolPart = {
  kind: 'tool';
  id: string;
  name: string;
  title?: string;
  input?: unknown;
  output?: string;
  error?: string;
  done: boolean;
  ms?: number;
};
type Part = { kind: 'text'; text: string } | { kind: 'error'; text: string } | ToolPart;

// An assistant turn is an ordered list of parts, so a multi-step answer shows
// text, then the tool it reached for, then more text: in the order it happened.
// What is shown; the model's own history (with tool calls and results) is kept
// separately as ModelMsg[].
type Msg = { role: 'user' | 'assistant'; content: string; at: string; parts?: Part[] };
/** A `!command` the user ran: its output, shown as is (`result` once it ends). */
type ShellMsg = { role: 'shell'; command: string; content: string; at: string; result?: ShellResult };
type Entry = Msg | ShellMsg;

/** The plain text of an assistant turn. */
/** How a `!command` ended, when that is worth saying. */
function shellStatus(r: ShellResult): string {
  return r.stopped ? 'stopped (esc)' : r.timedOut ? 'timed out and stopped' : r.exitCode === null ? 'failed to start' : r.exitCode ? `exit code ${r.exitCode}` : '';
}

/** Output rows shown for a `!command`; the rest is counted. */
const SHELL_ROWS = 40;

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

/** Local wall-clock stamp shown under each turn, e.g. "12:24 PM". */
function stamp(): string {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// --- Splash ---------------------------------------------------------------
// A 5-row block font, only for the letters in "LOCCI CHAT". Each glyph is 5
// wide and joined with a space, so LOCCI is 29 cols and CHAT is 23.
const GLYPHS: Record<string, string[]> = {
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  O: ['█████', '█   █', '█   █', '█   █', '█████'],
  C: ['█████', '█    ', '█    ', '█    ', '█████'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  H: ['█   █', '█   █', '█████', '█   █', '█   █'],
  A: ['█████', '█   █', '█████', '█   █', '█   █'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
};

/** Render a word as 5 strings of block characters. */
function banner(word: string): string[] {
  return [0, 1, 2, 3, 4].map((row) =>
    word
      .split('')
      .map((ch) => GLYPHS[ch]?.[row] ?? '     ')
      .join(' '),
  );
}

const LOCCI = banner('LOCCI'); // 29 cols
const CHAT = banner('CHAT'); //  23 cols
const WIDE = LOCCI.map((row, i) => `${row}   ${CHAT[i]}`); // one line, 55 cols
// Stacked form: centre the shorter word under the longer one.
const TALL = [...LOCCI, ...CHAT.map((row) => ' '.repeat(3) + row)];

/** Clip to `max` columns so a long string can never wrap and shift the layout. */
function fit(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Commands + shortcuts shown on the splash. Every one of these is wired up. */
const COMMANDS: { name: string; help: string; key: string }[] = [
  { name: '/help', help: 'show this screen', key: 'ctrl+h' },
  { name: '/clear', help: 'clear the conversation', key: 'ctrl+l' },
  { name: '/model', help: 'list or switch models', key: '' },
  { name: '/auto', help: 'YOLO mode: run commands without asking', key: '' },
  { name: '/think', help: 'thinking: on, off or auto', key: '' },
  { name: '!<cmd>', help: 'run a command here yourself', key: '' },
  { name: '/exit', help: 'quit', key: 'ctrl+c' },
];

function Splash({ width, height }: { width: number; height: number }) {
  // Degrade rather than letting anything wrap and shove the layout around:
  // one-line wordmark when it fits, stacked when narrow, plain text when tiny.
  const rows = width >= 62 ? WIDE : width >= 36 ? TALL : null;
  const showLogo = rows !== null && height >= 20;
  // The table needs 10 + 26 + 6 columns plus the root padding.
  const table = width >= 46 ? 'full' : width >= 34 ? 'compact' : 'none';

  return (
    <box
      style={{
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {showLogo ? (
        <box style={{ flexDirection: 'column', flexShrink: 0 }}>
          {rows.map((row, i) => (
            <text key={i} fg={i < 5 || rows === WIDE ? C.logo : C.logoDim}>
              {row}
            </text>
          ))}
        </box>
      ) : (
        <text fg={C.logo}>LOCCI CHAT</text>
      )}

      <box style={{ marginTop: 1, flexShrink: 0 }}>
        <text fg={C.dim}>v{VERSION}</text>
      </box>

      {table === 'full' ? (
        <box style={{ flexDirection: 'column', marginTop: 2, flexShrink: 0 }}>
          {COMMANDS.map((cmd) => (
            <box key={cmd.name} style={{ flexDirection: 'row' }}>
              <text fg={C.accent}>{cmd.name.padEnd(10)}</text>
              <text fg={C.dim}>{cmd.help.padEnd(26)}</text>
              <text fg={C.dim}>{cmd.key}</text>
            </box>
          ))}
        </box>
      ) : table === 'compact' ? (
        <box style={{ marginTop: 2, flexShrink: 0 }}>
          <text fg={C.accent}>{COMMANDS.map((c) => c.name).join(' ')}</text>
        </box>
      ) : null}
    </box>
  );
}

// --- Tool calls -----------------------------------------------------------
/** Compact one-line preview of a tool's arguments, e.g. `path: /tmp, depth: 2`. */
function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
}

/**
 * One tool call in the transcript. Collapsed it's a single muted line; expanded
 * it shows the arguments and result. ctrl+t toggles the focused one.
 */
function ToolRow({
  part,
  focused,
  expanded,
  width,
}: {
  part: ToolPart;
  focused: boolean;
  expanded: boolean;
  width: number;
}) {
  // Tools the TUI runs itself read as what they do: `$ ls`, `write TODOS.md`.
  const client = CLIENT_TOOL_NAMES.has(part.name);
  const label = client ? toolLabel(part.name, part.input as { command?: string; path?: string }) : (part.title ?? part.name);
  const secs = part.ms != null ? ` · ${(part.ms / 1000).toFixed(1)}s` : '';
  const marker = !part.done ? '⋯' : expanded ? '▾' : '▸';
  const tint = part.error ? C.warn : focused ? C.accent : C.dim;

  // Running: "Using X…". Finished: the marker line, expandable.
  // A client tool row says it was declined without being opened.
  const head = part.done
    ? `${marker} ${label}${secs}${client && part.error ? ` · ${fit(part.error.split('\n')[0], 60)}` : ''}`
    : client
      ? `${marker} ${label}`
      : `${marker} Using ${label}…`;
  const args = client ? '' : previewInput(part.input);

  const detail = part.error ?? part.output ?? '';
  const lines = detail.split('\n').slice(0, 20);
  const clipped = detail.split('\n').length > lines.length;

  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, marginBottom: 1 }}>
      <box style={{ flexDirection: 'row', flexShrink: 0 }}>
        <text fg={tint}>{focused && part.done ? `${head} ` : head}</text>
        {!expanded && args ? (
          <text fg={C.dim}>{fit(`  ${args}`, Math.max(0, width - head.length - 4))}</text>
        ) : null}
      </box>

      {expanded ? (
        <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 2 }}>
          {args ? <text fg={C.dim}>{fit(`in  ${args}`, width - 4)}</text> : null}
          {lines.map((line, i) => (
            <text key={i} fg={part.error ? C.warn : C.dim}>
              {fit(`${i === 0 ? 'out ' : '    '}${line}`, width - 4)}
            </text>
          ))}
          {clipped ? <text fg={C.dim}>    …</text> : null}
        </box>
      ) : null}
    </box>
  );
}

// --- App ------------------------------------------------------------------
function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();

  const [messages, setMessages] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [footer, setFooter] = useState('connecting…');
  const [showHelp, setShowHelp] = useState(false);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState(0);
  // Accordion state: which tool calls are open, and which one ctrl+t acts on.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toolFocus, setToolFocus] = useState(-1); // -1 = follow the newest
  // YOLO mode (--yolo or /auto): commands run without asking.
  const [yolo, setYolo] = useState(YOLO);
  // A command, a write, or the folder itself, waiting for y/n.
  // `action` marks a command or a write, which /auto can stop asking about.
  const [approval, setApproval] = useState<{ title: string; lines: string[]; question: string; action?: boolean } | null>(
    null,
  );
  // Off with --no-shell, or when the folder isn't allowed.
  const [shellOn, setShellOn] = useState(SHELL);
  const [composerRows, setComposerRows] = useState(1);
  const [think, setThink] = useState<ThinkSetting>(THINK);
  // The model is thinking (no text yet): shown in the hint line.
  const [thinking, setThinking] = useState(false);
  // A short message in the hint line (an image that couldn't be added).
  const [flash, setFlash] = useState('');
  // The model in use: --model, or one that reads images once the chat has one.
  const [activeModel, setActiveModel] = useState<string | undefined>(MODEL);
  const [models, setModels] = useState<{ default: string; models: ModelInfo[] } | null>(null);

  // Refs mirror state so the async send loop never reads a stale closure.
  const messagesRef = useRef<Entry[]>([]);
  const streamingRef = useRef(false);
  const draftRef = useRef('');
  // The keyboard handler is registered once, so the menu state it reads has to
  // live in refs too (synced from the derived values further down).
  const matchesRef = useRef<typeof COMMANDS>([]);
  const selectedRef = useRef(0);
  const menuOpenRef = useRef(false);
  const toolIdsRef = useRef<string[]>([]);
  const toolFocusRef = useRef(-1);
  const yoloRef = useRef(YOLO);
  const answerRef = useRef<((ok: boolean) => void) | null>(null);
  // What the model sees: user text, its replies, tool calls and results.
  const historyRef = useRef<ModelMsg[]>([]);
  // `!command` output, sent along with the next message so the model sees it.
  const ranRef = useRef<string[]>([]);
  // Esc stops the reply or the `!command` in progress through this.
  const stopRef = useRef<AbortController | null>(null);
  const shellRef = useRef(SHELL);
  const thinkRef = useRef<ThinkSetting>(THINK);
  const modelRef = useRef<string | undefined>(MODEL);
  // A model from /models that reads images, used from the first photo on.
  const imageModelRef = useRef<string | undefined>(undefined);
  // GET /models, for /model and its menu.
  const modelsRef = useRef<{ default: string; models: ModelInfo[] } | null>(null);
  const taRef = useRef<TextareaRenderable>(null);
  const widthRef = useRef(width);
  widthRef.current = width;
  // Placeholders in the draft and what they stand for, numbered per chat.
  const pastesRef = useRef(new Map<number, string>());
  const imagesRef = useRef(new Map<number, ImageAttachment>());
  const countersRef = useRef({ paste: 0, image: 0 });
  // Sent messages for Up/Down recall (src/history.ts), and where Up has got to:
  // the entry shown and the draft to go back to.
  const sentRef = useRef<string[]>([]);
  const browseRef = useRef<{ index: number; draft: string } | null>(null);

  // Ask the server what it's running, so the footer isn't guessing from env.
  useEffect(() => {
    let alive = true;
    fetch(`${API}/info`)
      .then((r) => r.json() as Promise<{ provider: string; model: string; tools: number }>)
      .then((d) => {
        if (!alive) return;
        setFooter(`${d.provider} ${d.model}${d.tools ? ` · ${d.tools} tools` : ''}`);
      })
      .catch(() => alive && setFooter('server offline'));
    fetchModels()
      .then((list) => {
        if (!alive) return;
        modelsRef.current = list;
        setModels(list);
        imageModelRef.current = list.models.find((m) => m.images && !m.disabled)?.id;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const quit = useCallback(() => {
    renderer.destroy();
    process.exit(0);
  }, [renderer]);

  /** Put `text` in the composer, cursor at the end. */
  const setInput = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
    const ta = taRef.current;
    if (ta) {
      ta.setText(text);
      ta.cursorOffset = text.length;
    }
    setComposerRows(rowsFor(text, widthRef.current - 4));
  }, []);

  const clear = useCallback(() => {
    messagesRef.current = [];
    historyRef.current = [];
    ranRef.current = [];
    pastesRef.current.clear();
    imagesRef.current.clear();
    countersRef.current = { paste: 0, image: 0 };
    setMessages([]);
    setShowHelp(false);
    setInput('');
  }, [setInput]);

  /**
   * Up on the draft's first line shows the message sent before (again for
   * older ones); Down on its last line goes forward, then back to the draft.
   * In a multi-line draft the arrows move between lines first.
   */
  const recall = useCallback(
    (direction: 'up' | 'down') => {
      const ta = taRef.current;
      const sent = sentRef.current;
      if (!ta || sent.length === 0) return;
      const row = ta.logicalCursor.row;
      if (direction === 'up') {
        if (row !== 0) return;
        const browse = browseRef.current;
        if (!browse) browseRef.current = { index: sent.length - 1, draft: draftRef.current };
        else if (browse.index > 0) browse.index--;
        else return;
        setInput(sent[browseRef.current!.index]);
      } else {
        const browse = browseRef.current;
        if (!browse || row !== ta.lineCount - 1) return;
        if (browse.index < sent.length - 1) {
          browse.index++;
          setInput(sent[browse.index]);
        } else {
          browseRef.current = null;
          setInput(browse.draft);
        }
      }
    },
    [setInput],
  );

  /**
   * Ctrl+L and /clear: wipe the conversation, after a yes. Nothing is saved
   * yet (see BACKLOG "--resume"), so a wiped chat can't be brought back.
   */
  const askClear = useCallback(() => {
    if (streamingRef.current || answerRef.current) return;
    if (messagesRef.current.length === 0) return clear();
    answerRef.current = (yes) => {
      answerRef.current = null;
      setApproval(null);
      if (yes) clear();
    };
    setApproval({
      title: 'Start a new chat?',
      lines: ["This conversation is wiped. It isn't saved anywhere, so it can't be brought back."],
      question: 'Clear it?',
    });
  }, [clear]);

  const say = useCallback((message: string) => {
    setFlash(message);
    setTimeout(() => setFlash((f) => (f === message ? '' : f)), 4000);
  }, []);

  /** Add an image to the draft as `[Image #n]`. */
  const attachImage = useCallback(
    async (file: string) => {
      try {
        const image = await loadImage(file);
        const n = ++countersRef.current.image;
        imagesRef.current.set(n, { n, ...image });
        taRef.current?.insertText(`[Image #${n}] `);
      } catch (err) {
        say(`Couldn't add the image: ${(err as Error).message}`);
      }
    },
    [say],
  );

  /** Ctrl+V: the clipboard's image, if it holds one (text pastes come as paste events). */
  const pasteClipboardImage = useCallback(async () => {
    const clip = await clipboardImage();
    if (!clip) {
      say('No image on the clipboard');
      return;
    }
    try {
      await attachImage(clip.file);
    } finally {
      await clip.cleanup();
    }
  }, [attachImage, say]);

  /**
   * A paste: image file paths (a file dragged into the terminal) become
   * `[Image #n]`, a long text `[Pasted text #n +L lines]`; anything short goes
   * in as typed. The placeholders are replaced when the message is sent.
   */
  const onPaste = useCallback(
    (event: PasteEvent) => {
      const text = new TextDecoder().decode(event.bytes).replace(/\r\n?/g, '\n');
      let files: string[] | null = null;
      try {
        files = imagePaths(text, CWD);
      } catch {
        // not paths: treat it as text
      }
      if (files) {
        event.preventDefault();
        files.reduce((chain, f) => chain.then(() => attachImage(f)), Promise.resolve());
        return;
      }
      const lines = text.replace(/\n$/, '').split('\n').length;
      if (lines < PASTE_LINES && text.length < PASTE_CHARS) return; // the textarea inserts it
      event.preventDefault();
      const n = ++countersRef.current.paste;
      pastesRef.current.set(n, text);
      taRef.current?.insertText(lines > 1 ? `[Pasted text #${n} +${lines} lines] ` : `[Pasted text #${n}, ${text.length} chars] `);
    },
    [attachImage],
  );

  useKeyboard((key) => {
    // Something is waiting: only y allows it; n or Esc declines.
    // Esc during a reply also stops it.
    if (answerRef.current) {
      if (key.name === 'y') answerRef.current(true);
      else if (key.name === 'n' || key.name === 'escape') {
        answerRef.current(false);
        if (key.name === 'escape') stopRef.current?.abort();
      }
      return;
    }
    if (key.name === 'escape') {
      // Stops a reply or a command that is taking too long; otherwise closes
      // the command menu. It never quits: a second Esc to stop would.
      if (streamingRef.current) stopRef.current?.abort();
      else if (menuOpenRef.current) setInput('');
    } else if (key.ctrl && key.name === 'v') pasteClipboardImage();
    else if (key.ctrl && key.name === 'l') askClear();
    else if (key.ctrl && key.name === 'h') setShowHelp((v) => !v);
    else if (key.ctrl && key.name === 't') {
      // Toggle the focused tool call open/closed.
      const ids = toolIdsRef.current;
      const id = ids[toolFocusRef.current === -1 ? ids.length - 1 : toolFocusRef.current];
      if (id) {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
    } else if (key.ctrl && (key.name === 'up' || key.name === 'down')) {
      // Walk between tool calls; from -1 (newest) step back through the list.
      const n = toolIdsRef.current.length;
      if (n > 0) {
        setToolFocus((f) => {
          const cur = f === -1 ? n - 1 : f;
          return key.name === 'up' ? (cur - 1 + n) % n : (cur + 1) % n;
        });
      }
    } else if (
      // While going through history, the arrows stay on it even when a
      // recalled "/command" opens the menu.
      (browseRef.current || !menuOpenRef.current) &&
      !streamingRef.current &&
      !key.ctrl &&
      !key.meta &&
      (key.name === 'up' || key.name === 'down')
    ) {
      recall(key.name);
    } else if (menuOpenRef.current && (key.name === 'up' || key.name === 'down')) {
      const n = matchesRef.current.length;
      setSelected((s) => (key.name === 'up' ? (s - 1 + n) % n : (s + 1) % n));
    } else if (menuOpenRef.current && key.name === 'tab') {
      const pick = matchesRef.current[selectedRef.current];
      if (pick) setInput(pick.name);
    }
  });

  /** A local line in the transcript; never sent to the model. */
  const note = useCallback((content: string) => {
    messagesRef.current = [...messagesRef.current, { role: 'assistant', content, at: stamp() }];
    setMessages(messagesRef.current);
    setShowHelp(false);
  }, []);

  /** Local slash commands. Returns true when the input was handled here. */
  const runCommand = useCallback(
    (text: string): boolean => {
      if (text.startsWith('/model ')) {
        const list = modelsRef.current;
        const id = text.slice('/model '.length).trim();
        if (!list) note("The model list isn't loaded (GET /models failed).");
        else {
          const pick = pickModel(list, id);
          if (!pick.ok) note(pick.error);
          else {
            // The history stays; photos in it become notes for a model that can't see them.
            modelRef.current = pick.model.id;
            setActiveModel(pick.model.id);
            note(`Now using ${pick.model.id}.${pick.warning ? ` ${pick.warning}` : ''}`);
          }
        }
        return true;
      }
      switch (text.startsWith('/think ') ? '/think' : text) {
        case '/think': {
          const next = parseThink(text, thinkRef.current);
          if (next) {
            thinkRef.current = next;
            setThink(next);
          }
          note(next ? THINK_NOTE[thinkRef.current] : 'Use /think on, /think off or /think auto.');
          return true;
        }
        case '/auto': {
          if (!shellRef.current) {
            note('Shell commands are off in this chat.');
            return true;
          }
          yoloRef.current = !yoloRef.current;
          setYolo(yoloRef.current);
          note(
            yoloRef.current
              ? 'YOLO mode on: commands run without asking. /auto again to turn it off.'
              : 'YOLO mode off: each command asks first.',
          );
          return true;
        }
        case '/exit':
        case '/quit':
          quit();
          return true;
        case '/clear':
          askClear();
          return true;
        case '/help':
          setShowHelp(true);
          return true;
        case '/model': {
          // The list; `/model <id>` (or the menu) switches, below.
          const list = modelsRef.current;
          if (!list) {
            note(`${footer}. The model list isn't loaded (GET /models failed).`);
            return true;
          }
          const current = modelRef.current ?? list.default;
          note(
            [
              'Models (type `/model ` to pick one, or `/model <id>`):',
              '',
              ...list.models.map(
                (m) =>
                  `- \`${m.id}\`${m.id === current ? ' **(in use)**' : ''} ${m.description ?? ''} (${m.tools ? 'tools' : 'no tools'}${m.images ? ', images' : ''})${m.disabled ? ', unavailable' : ''}`,
              ),
            ].join('\n'),
          );
          return true;
        }
        default:
          return false;
      }
    },
    [quit, clear, askClear, footer, note],
  );

  useEffect(() => {
    loadHistory().then((entries) => {
      sentRef.current = [...entries, ...sentRef.current];
    });
  }, []);

  // A folder is asked about once, then remembered (src/trust.ts).
  useEffect(() => {
    if (!SHELL) return;
    isTrusted(CWD).then((ok) => {
      if (ok) return;
      answerRef.current = (yes) => {
        answerRef.current = null;
        setApproval(null);
        if (yes) {
          trust(CWD).catch(() => {});
        } else {
          shellRef.current = false;
          setShellOn(false);
          note('No commands in this chat: the folder was not allowed.');
        }
      };
      setApproval({
        title: TRUST_QUESTION(CWD),
        lines: ['Asked once per folder. Each command and write still asks unless YOLO mode is on.'],
        question: 'Allow?',
      });
    });
  }, [note]);

  /** Resolves true when the command or write may go ahead: at once in YOLO mode, else on y. */
  const approve = useCallback(
    (action: Action) =>
      yoloRef.current
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            answerRef.current = (ok) => {
              answerRef.current = null;
              setApproval(null);
              resolve(ok);
            };
            if (action.kind === 'shell') {
              setApproval({ title: `$ ${action.command}`, lines: [], question: `Run in ${CWD}?`, action: true });
            } else if (action.kind === 'edit') {
              setApproval({
                title: `Edit ${action.path}${action.count > 1 ? ` (${action.count} places)` : ''}`,
                lines: editPreview(action, 5),
                question: 'Make this edit?',
                action: true,
              });
            } else {
              const lines = action.content.split('\n');
              const shown = lines.slice(0, 10);
              if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more lines`);
              setApproval({
                title: `${action.creates ? 'Create' : 'Replace'} ${action.path} (${lines.length} lines)`,
                lines: shown,
                question: 'Write it?',
                action: true,
              });
            }
          }),
    [],
  );

  const send = useCallback(async () => {
    let text = draftRef.current.trim();
    if (!text || streamingRef.current) return;

    // Enter on an open command menu runs the highlighted entry, so a partial
    // "/cl" submits /clear rather than being sent to the model.
    if (menuOpenRef.current) {
      text = matchesRef.current[selectedRef.current]?.name ?? text;
    }

    setInput('');
    browseRef.current = null;

    // Recalled with Up later: pasted text in full, so it still means something
    // once the placeholder's paste is gone.
    const recalled = text.replace(PASTE_TOKEN, (token, n) => pastesRef.current.get(Number(n)) ?? token);
    sentRef.current = [...sentRef.current, recalled];
    remember(sentRef.current.slice(0, -1), recalled).then((kept) => {
      sentRef.current = kept;
    });

    if (runCommand(text)) return;

    // Placeholders: pasted text goes back in full (and is shown in full from
    // now on); images stay `[Image #n]` in the transcript and go to the model
    // as image parts.
    const full = text.replace(PASTE_TOKEN, (token, n) => pastesRef.current.get(Number(n)) ?? token);
    const images = [...text.matchAll(IMAGE_TOKEN)]
      .map((m) => imagesRef.current.get(Number(m[1])))
      .filter((image): image is ImageAttachment => Boolean(image));
    pastesRef.current.clear();

    // `!command`: the user's own, run here at once without asking (even with
    // --no-shell, which is about the model). Not sent; its output goes along
    // with the next message.
    if (full.startsWith('!')) {
      const command = full.slice(1).trim();
      if (!command) {
        note(`Type a command after the !, e.g. !ls. It runs in ${CWD}.`);
        return;
      }
      streamingRef.current = true;
      setStreaming(true);
      setShowHelp(false);
      const at = stamp();
      const show = (entry: ShellMsg) => {
        const rest = messagesRef.current.filter((m) => m !== running);
        messagesRef.current = [...rest, entry];
        setMessages(messagesRef.current);
      };
      const running: ShellMsg = { role: 'shell', command, content: '', at };
      show(running);
      const stopper = new AbortController();
      stopRef.current = stopper;
      try {
        const result = await runShell(command, CWD, stopper.signal);
        show({ role: 'shell', command, content: result.output.trimEnd(), at, result });
        ranRef.current = [...ranRef.current, userRanNote(command, result)];
      } finally {
        stopRef.current = null;
        streamingRef.current = false;
        setStreaming(false);
      }
      return;
    }

    // From the first photo on, the chat uses a model that reads images: the
    // history keeps the photos, and a model that can't see them refuses them.
    const current = modelRef.current ?? modelsRef.current?.default;
    const sees = modelsRef.current?.models.find((m) => m.id === current)?.images ?? false;
    if (images.length > 0 && !sees) {
      if (!imageModelRef.current) {
        note('No model here reads images: the API lists none in /models (try gemma-4-e2b).');
        return;
      }
      modelRef.current = imageModelRef.current;
      setActiveModel(imageModelRef.current);
      note(`Switched to ${imageModelRef.current} for the photo (${current ?? 'the default'} can't see images).`);
    }

    streamingRef.current = true;
    setStreaming(true);
    setShowHelp(false);

    const base: Entry[] = [...messagesRef.current, { role: 'user', content: full, at: stamp() }];
    // Commands run with ! since the last message, ahead of what was typed.
    const ran = ranRef.current;
    ranRef.current = [];
    const said = ran.length ? `${ran.join('\n')}\n\n${full}` : full;
    const parts: Part[] = [];
    const started = new Map<string, number>();
    const history = historyRef.current;
    const start = history.length;
    history.push({
      role: 'user',
      content:
        images.length === 0
          ? said
          : [
              // Images first: Gemma ignores one after the text when tools are on.
              ...images.map((image) => ({
                type: 'file',
                mediaType: image.mediaType,
                data: image.data,
                filename: `Image #${image.n} (${image.name})`,
              })),
              { type: 'text', text: said },
            ],
    });

    const commit = () => {
      const updated: Entry[] = [
        ...base,
        { role: 'assistant', content: textOf(parts), at: stamp(), parts: [...parts] },
      ];
      messagesRef.current = updated;
      setMessages(updated);
    };
    commit(); // placeholder turn, so the transcript reacts immediately

    const fail = (message: string) => {
      parts.push({ kind: 'text', text: message });
      commit();
    };

    /** Append a text delta, merging into the trailing text part. */
    const addText = (chunk: string) => {
      const last = parts[parts.length - 1];
      if (last?.kind === 'text') last.text += chunk;
      else parts.push({ kind: 'text', text: chunk });
    };

    const tool = (id: string) =>
      parts.find((p): p is ToolPart => p.kind === 'tool' && p.id === id);

    const onEvent = (event: ChatEvent) => {
      setThinking(event.t === 'thinking');
      switch (event.t) {
        case 'text':
          addText(event.v ?? '');
          break;
        case 'tool':
          started.set(event.id, Date.now());
          parts.push({
            kind: 'tool',
            id: event.id,
            name: event.name ?? 'tool',
            title: event.title,
            done: false,
          });
          break;
        case 'tool-input':
        case 'tool-call': {
          const t = tool(event.id);
          if (t) t.input = event.input;
          break;
        }
        case 'tool-done': {
          const t = tool(event.id);
          if (t) {
            t.done = true;
            t.output = event.output;
            t.error = event.error;
            t.ms = Date.now() - (started.get(event.id) ?? Date.now());
          }
          break;
        }
        case 'error':
          // Its own part, not body text: a provider failure isn't
          // something the model said, and it must not go back as history.
          parts.push({ kind: 'error', text: event.v ?? 'stream error' });
          break;
        case 'finish':
          // The gateway stopped at max_tokens / the context window: say so
          // instead of leaving a silently truncated answer.
          if (event.reason === 'length') {
            parts.push({ kind: 'error', text: 'answer cut off: hit the token limit' });
          }
          break;
      }
      commit();
    };

    const stopper = new AbortController();
    stopRef.current = stopper;
    try {
      await runTurn(
        history,
        {
          system: SYSTEM,
          model: modelRef.current,
          reasoning: shellRef.current ? thinkFlag(thinkRef.current) : undefined,
          shell: shellRef.current,
          cwd: CWD,
          approve,
          // A client tool is finished here, not by the API: show its result.
          onToolResult: ({ id }, result) => {
            const t = tool(id);
            if (t) {
              t.done = true;
              if (result.startsWith(DECLINED_PREFIX)) t.error = 'declined';
              // A failed command or an edit that couldn't apply reads as a
              // failure (red, first line in the row), not as done.
              else if (/^(exit code [1-9]|timed out|failed to start|stopped by|\[stopped|Nothing changed|old_text |Could not |edit_file needs)/.test(result)) t.error = result;
              else t.output = result;
              t.ms = Date.now() - (started.get(id) ?? Date.now());
            }
            commit();
          },
        },
        onEvent,
        stopper.signal,
      );
      commit();
    } catch (err) {
      // Esc: what was said and done stays in the history (runTurn closed it off).
      if ((err as Error).name === 'AbortError') {
        for (const p of parts) if (p.kind === 'tool' && !p.done) Object.assign(p, { done: true, error: 'stopped' });
        parts.push({ kind: 'error', text: 'stopped (esc)' });
        commit();
        return;
      }
      // Not sent, so not history either.
      history.length = start;
      ranRef.current = [...ran, ...ranRef.current];
      const message = (err as Error).message;
      fail(message === 'fetch failed' ? `⚠️  Server unreachable at ${API}. Start it with: just examples-api` : `⚠️  ${message}`);
    } finally {
      stopRef.current = null;
      streamingRef.current = false;
      setStreaming(false);
      setThinking(false);
    }
  }, [runCommand, approve, setInput, note]);

  const empty = messages.length === 0 || showHelp;

  // Every tool call in the transcript, flattened, so ctrl+t / ctrl+↑↓ can walk
  // them regardless of which turn they belong to.
  const toolIds = useMemo(
    () =>
      messages.flatMap((m) => (m.role === 'shell' ? [] : (m.parts ?? [])).filter((p) => p.kind === 'tool').map((p) => p.id)),
    [messages],
  );
  // -1 follows the newest call, so the thing you just watched run is the thing
  // ctrl+t opens.
  const focusId = toolIds[toolFocus === -1 ? toolIds.length - 1 : toolFocus];
  toolIdsRef.current = toolIds;
  toolFocusRef.current = toolFocus;

  const hint = flash
    ? flash
    : approval
    ? 'y yes · n no'
    : streaming
    ? thinking
      ? 'thinking… · esc to stop'
      : 'streaming… · esc to stop'
    : draft.startsWith('!')
      ? `enter runs it in ${CWD}`
    : toolIds.length > 0
      ? 'enter send · ctrl+j new line · ctrl+t details'
      : 'enter send · ctrl+j new line · ctrl+v image';

  // Typing "/" opens a completion menu above the composer, filtered by prefix.
  const matches = useMemo(() => {
    if (!draft.startsWith('/') || streaming) return [];
    const q = draft.toLowerCase();
    // "/model " lists the models to switch to, filtered as you type the id.
    if (q.startsWith('/model ') && models) {
      const current = activeModel ?? models.default;
      return models.models
        .filter((m) => !m.disabled && `/model ${m.id}`.startsWith(q))
        .map((m) => ({
          name: `/model ${m.id}`,
          help: `${m.id === current ? '(in use) ' : ''}${m.description ?? ''}${m.tools ? '' : ' (no tools)'}`,
          key: '',
        }));
    }
    return COMMANDS.filter((c) => c.name.startsWith(q));
  }, [draft, streaming, models, activeModel]);
  const nameWidth = Math.max(9, ...matches.map((m) => m.name.length + 2));
  const menuOpen = matches.length > 0;
  const index = Math.min(selected, matches.length - 1);

  matchesRef.current = matches;
  selectedRef.current = index;
  menuOpenRef.current = menuOpen;

  return (
    // Every child below is either flexShrink:0 (fixed chrome) or the one
    // flexible pane with minHeight:0. Without that, Yoga squeezes the borders
    // of the fixed rows once the transcript outgrows the viewport, which is
    // what used to make the header drift and collapse into its own text.
    <box style={{ flexDirection: 'column', height: '100%', padding: 1 }}>
      {empty ? (
        <Splash width={width} height={height} />
      ) : (
        <scrollbox
          stickyScroll
          stickyStart="bottom"
          style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, marginBottom: 1 }}
        >
          {messages.map((m, i) => {
            if (m.role === 'shell') {
              const rows = m.content.split('\n');
              const shown = rows.slice(0, SHELL_ROWS);
              const status = m.result ? shellStatus(m.result) : '';
              return (
                <box
                  key={i}
                  style={{
                    flexDirection: 'column',
                    flexShrink: 0,
                    marginBottom: 1,
                    border: ['left'],
                    borderStyle: 'heavy',
                    borderColor: C.agent,
                    backgroundColor: C.agentBlock,
                    paddingLeft: 1,
                    paddingTop: 1,
                    paddingBottom: 1,
                  }}
                >
                  <text fg={C.agent}>{`! ${m.command}`}</text>
                  {m.result ? (
                    m.content ? (
                      shown.map((line, r) => <text key={r}>{line || ' '}</text>)
                    ) : (
                      <text fg={C.dim}>(no output)</text>
                    )
                  ) : (
                    <text fg={C.dim}>running…</text>
                  )}
                  {rows.length > shown.length ? <text fg={C.dim}>{`… ${rows.length - shown.length} more lines`}</text> : null}
                  <box style={{ flexDirection: 'row', flexShrink: 0 }}>
                    <text fg={C.dim}>{`shell (${m.at})`}</text>
                    {status ? <text fg={C.warn}>{` · ${status}`}</text> : null}
                  </box>
                </box>
              );
            }
            const pending = streaming && i === messages.length - 1 && !m.content;
            const body = m.content || (pending ? '…' : '');

            // User turns sit in a tinted block behind an accent gutter; agent
            // turns run full-width so long answers stay easy to read.
            return m.role === 'user' ? (
              <box
                key={i}
                style={{
                  flexDirection: 'column',
                  flexShrink: 0,
                  marginBottom: 1,
                  border: ['left'],
                  borderStyle: 'heavy',
                  borderColor: C.user,
                  backgroundColor: C.userBlock,
                  paddingLeft: 1,
                  paddingTop: 1,
                  paddingBottom: 1,
                }}
              >
                <text>{body}</text>
                <text fg={C.dim}>you ({m.at})</text>
              </box>
            ) : (
              <box
                key={i}
                style={{
                  flexDirection: 'column',
                  flexShrink: 0,
                  marginBottom: 1,
                  backgroundColor: C.agentBlock,
                  paddingLeft: 1,
                  paddingRight: 1,
                  paddingTop: 1,
                  paddingBottom: 1,
                }}
              >
                {m.parts?.length ? (
                  m.parts.map((part, p) =>
                    part.kind === 'tool' ? (
                      <ToolRow
                        key={part.id}
                        part={part}
                        focused={part.id === focusId}
                        expanded={expanded.has(part.id)}
                        width={width - 4}
                      />
                    ) : part.kind === 'error' ? (
                      <box key={`e-${p}`} style={{ flexDirection: 'row', flexShrink: 0 }}>
                        <text fg={C.warn}>{'✗ '}</text>
                        <text fg={C.warn}>{part.text}</text>
                      </box>
                    ) : (
                      <Markdown key={`t-${p}`} source={part.text} width={width - 4} />
                    ),
                  )
                ) : pending ? (
                  <text fg={C.dim}>…</text>
                ) : (
                  <Markdown source={body} width={width - 4} />
                )}
                <text fg={C.dim}>{`Agent (${m.at})`}</text>
              </box>
            );
          })}
        </scrollbox>
      )}

      {/* Composer: when the command menu is open it shares the input's
          background and borders so the two read as one panel. */}
      <box style={{ flexDirection: 'column', flexShrink: 0, marginTop: 1 }}>
        {approval !== null ? (
          <box
            style={{
              flexDirection: 'column',
              flexShrink: 0,
              border: true,
              borderColor: C.agent,
              backgroundColor: C.panel,
              paddingLeft: 1,
              paddingRight: 1,
              marginBottom: 1,
            }}
          >
            <text fg={C.agent}>{fit(approval.title, width - 6)}</text>
            {approval.lines.map((line, i) => (
              <text key={i} fg={C.dim}>
                {fit(`  ${line}`, width - 6)}
              </text>
            ))}
            <text fg={C.dim}>{fit(approval.question, width - 6)}</text>
            <box style={{ flexDirection: 'row' }}>
              <text fg={C.accent}>y</text>
              <text fg={C.dim}> yes   </text>
              <text fg={C.accent}>n</text>
              <text fg={C.dim}> no   </text>
              {width >= 70 && approval.action ? <text fg={C.dim}>(/auto stops asking)</text> : null}
            </box>
          </box>
        ) : null}
        {menuOpen ? (
          <box
            style={{
              flexDirection: 'column',
              flexShrink: 0,
              border: ['left', 'right', 'top'],
              borderColor: C.accent,
              backgroundColor: C.panel,
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            {matches.map((cmd, i) => (
              <box
                key={cmd.name}
                style={{
                  flexDirection: 'row',
                  backgroundColor: i === index ? C.selected : undefined,
                }}
              >
                <text fg={C.accent}>{cmd.name.padEnd(nameWidth)}</text>
                <text fg={C.dim}>{fit(cmd.help, Math.max(0, width - nameWidth - 6))}</text>
              </box>
            ))}
          </box>
        ) : null}

        <box
          style={{
            border: menuOpen ? ['left', 'right', 'bottom'] : true,
            // Amber while the draft is a `!command`, as the shell turn shows.
            borderColor: streaming ? C.dim : draft.startsWith('!') ? C.agent : C.accent,
            backgroundColor: C.panel,
            // The draft's rows plus borders (the menu supplies the top one);
            // it grows as lines are added, up to MAX_COMPOSER_ROWS.
            height: composerRows + (menuOpen ? 1 : 2),
            flexShrink: 0,
          }}
        >
          <textarea
            ref={taRef}
            placeholder={streaming ? 'streaming…' : 'Type a message, Enter to send'}
            keyBindings={COMPOSER_KEYS}
            wrapMode="word"
            onContentChange={() => {
              const ta = taRef.current;
              if (!ta) return;
              draftRef.current = ta.plainText;
              setDraft(ta.plainText);
              setSelected(0);
              setComposerRows(rowsFor(ta.plainText, width - 4));
            }}
            onPaste={onPaste}
            onSubmit={send}
            focused={!streaming && approval === null}
          />
        </box>
      </box>

      <box
        style={{ flexDirection: 'row', justifyContent: 'space-between', height: 1, flexShrink: 0 }}
      >
        {/* Drop the hint before the two halves can overlap on a narrow terminal. */}
        {width - 2 >= hint.length + footer.length + (yolo ? 7 : 0) + (think !== 'auto' && shellOn ? think.length + 9 : 0) + (activeModel ? activeModel.length + 3 : 0) + 2 ? <text fg={C.dim}>{hint}</text> : <text />}
        <text fg={footer === 'server offline' ? C.warn : yolo ? C.agent : C.dim}>
          {fit(`${yolo ? 'YOLO · ' : ''}${think !== 'auto' && shellOn ? `think ${think} · ` : ''}${activeModel ? `${activeModel} · ` : ''}${footer}`, width - 4)}
        </text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);

// Ctrl+C is handled by exitOnCtrlC; also restore the terminal on SIGTERM
// (e.g. when the parent CLI forwards a signal) so we don't leave it in raw mode.
process.on('SIGTERM', () => {
  try {
    renderer.destroy();
  } catch {
    // ignore: best-effort terminal restore
  }
  process.exit(0);
});
