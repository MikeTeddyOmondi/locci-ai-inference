import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import Firecrawl from '@mendable/firecrawl-js';

// The web example's tools, moved server-side unchanged from autonomous-chatbot's
// src/routes/api/chat/+server.ts so the CLI gets them too. Each one is
// registered only when its key is set; a missing key is logged at startup.

// Firecrawl response types
interface FirecrawlSearchResult {
  title?: string;
  description?: string;
  url?: string;
  markdown?: string;
  links?: string[];
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
  };
}

/**
 * Firecrawl 4.x (its v2 API) returns results under `web`; there is no
 * `success`/`data` envelope any more. Each item is a plain result, or a scraped
 * document when `scrapeOptions` asks for content.
 */
interface FirecrawlSearchResponse {
  web?: FirecrawlSearchResult[];
}

/**
 * The web endpoint's system prompt. Small models follow short numbered rules
 * better than prose, and need today's date to know what "latest" means. Tool
 * rules are included only for tools the request actually has: a model told to
 * use a search tool it was not given prints a fake call as text instead.
 */
export function webSystemPrompt(opts: {
  now: Date;
  /**
   * `available`: the model may call search; `done`: results for this question are in the conversation;
   * `earlier`: no search this turn, but earlier turns' results are in the conversation.
   */
  search: 'available' | 'done' | 'earlier' | 'none';
  weather: boolean;
}): string {
  const today = opts.now.toISOString().slice(0, 10);
  const rules: string[] = [];
  if (opts.search === 'done') {
    rules.push(
      "Web search results for the user's question are already in this conversation, as a search tool " +
        'result. Answer from them, not from memory, and give a full answer. If they disagree with what you ' +
        'remember, trust the results. Name the sources (site or URL) you used.',
      "If the results don't cover the question, say so, then answer from memory and warn that it may be " +
        'out of date.',
    );
  } else if (opts.search === 'earlier') {
    rules.push(
      'Web search results from earlier in this conversation are included as search tool results. Where they ' +
        'cover the question, answer from them, not from memory, and name the sources (site or URL) you used.',
    );
  } else if (opts.search === 'available') {
    rules.push(
      'Your own knowledge is out of date. For any question that depends on facts, technical or not ' +
        '(libraries, frameworks, APIs, versions, releases, docs, error messages; news, people, companies, ' +
        'products, prices, events, places), call the search tool before answering, even when you think you ' +
        'know the answer.',
      'Answer from the search results, not from memory. If they disagree with what you remember, trust the ' +
        'results. Name the sources (site or URL) you used.',
      'Skip the search only for greetings and small talk, or when the user only wants you to work on text ' +
        'they gave you (summarise, rewrite, translate, explain a pasted file).',
      'If the search fails or finds nothing useful, say so, then answer from memory and warn that it may be ' +
        'out of date.',
    );
  }
  if (opts.weather) rules.push('For weather, use the weather tool.');
  rules.push(
    'Files and pasted text the user attaches are included in their message in full. Read them there; never ' +
      'use file or directory tools to open an attachment.',
    'Keep answers clear, accurate and concise.',
  );
  return [
    `You are Locci AI, a helpful assistant. Today is ${today}.`,
    '',
    ...rules.map((rule, i) => `${i + 1}. ${rule}`),
  ].join('\n');
}

function weatherTool(apiKey: string) {
  return tool({
    description:
      'Get current weather information for a specific location using latitude and longitude coordinates',
    inputSchema: z.object({
      latitude: z.number().min(-90).max(90).describe('The latitude of the location (between -90 and 90)'),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe('The longitude of the location (between -180 and 180)'),
    }),
    execute: async ({ latitude, longitude }) => {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${latitude}&lon=${longitude}&units=metric&appid=${apiKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`OpenWeatherMap API error: ${response.statusText}`);
      }

      const data = await response.json();

      return {
        location: { latitude, longitude },
        weather: {
          temperature: `${data.main.temp}°C`,
          feels_like: `${data.main.feels_like}°C`,
          condition: data.weather[0].description,
          humidity: `${data.main.humidity}%`,
          pressure: `${data.main.pressure} hPa`,
          wind_speed: `${data.wind.speed} m/s`,
          cloud_coverage: `${data.clouds.all}%`,
        },
      };
    },
  });
}

/**
 * Scraped markdown, trimmed for a small model's context: images dropped, links
 * reduced to their text, table rules and runs of whitespace collapsed. Link-heavy
 * pages (Wikipedia) cost several times more tokens per character before this.
 */
function compactMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[\s|:-]+$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function searchTool(apiKey: string, maxChars: number) {
  const firecrawl = new Firecrawl({ apiKey });
  return tool({
    description:
      'Search the web and retrieve content from search results. Use this to find current information, news, documentation, or any web content.',
    inputSchema: z.object({
      query: z.string().describe('The search query to find relevant web content'),
      limit: z
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe('Number of search results to return (1-5, default 3)'),
    }),
    execute: async ({ query, limit = 3 }) => {
      const response = (await firecrawl.search(query, {
        limit,
        scrapeOptions: { formats: ['markdown'] },
      })) as unknown as FirecrawlSearchResponse;

      if (!Array.isArray(response?.web)) {
        throw new Error('Search failed: unexpected response from Firecrawl');
      }

      // Pages that failed to scrape come back as an error page; skip them.
      const items = response.web.filter((item) => !/^\s*Error \d{3}\b/.test(item.markdown ?? ''));
      // One budget shared by all results, so the tool output stays a fixed
      // share of the model's context however many results come back.
      const perResult = Math.floor(maxChars / Math.max(items.length, 1));

      return {
        query,
        results: items.map((item) => ({
          title: item.title ?? item.metadata?.title,
          url: item.url ?? item.metadata?.sourceURL,
          description: clip(compactMarkdown(item.description ?? item.metadata?.description ?? ''), 200),
          content: clip(item.markdown ? compactMarkdown(item.markdown) : undefined, perResult),
        })),
      };
    },
  });
}

/**
 * Tools the client runs, not the API: no `execute`, so the AI SDK ends the
 * step with the call (`finishReason: 'tool-calls'`) and the client posts the
 * result back. Only added for a request that lists them in `clientTools`.
 * The API never runs a command: a shell here would be a shell on the server
 * for every signed-in user (or for a page read during a search).
 */
export const CLIENT_TOOLS: ToolSet = {
  shell: tool({
    description:
      "Run a shell command on the user's machine, in their project folder. Use it to look around, run " +
      'programs, tests and builds, or install what a task needs. Not for writing files: use write_file. The ' +
      'user approves each command and may decline. Returns the exit code and the output (long output is cut).',
    inputSchema: z.object({
      command: z.string().describe('The command line to run, as typed in a terminal'),
    }),
  }),
  read_file: tool({
    description:
      "Read a text file in the user's project folder (or list a folder). Paths are relative to the folder.",
    inputSchema: z.object({
      path: z.string().describe('File or folder path, relative to the project folder, e.g. "package.json"'),
    }),
  }),
  edit_file: tool({
    description:
      "Change part of a file in the user's project folder: old_text is removed and new_text is put in its " +
      'place, so anything in old_text that should stay must be in new_text too (to add a line after a line, ' +
      'old_text is that line and new_text is that line, a new line, then the added line). old_text must be ' +
      'copied exactly from the file (read it first). Set all to true to replace every place old_text appears. ' +
      'Returns the file as it now reads. The user approves each edit.',
    inputSchema: z.object({
      path: z.string().describe('File path, relative to the project folder, e.g. "TODOS.md"'),
      old_text: z.string().describe('The exact text to replace, copied from the file'),
      new_text: z.string().describe('The text to put in its place'),
      all: z.boolean().optional().describe('Replace every place old_text appears (default: only one)'),
    }),
  }),
  write_file: tool({
    description:
      "Create a file in the user's project folder, or replace all of it, with the complete content in one call. " +
      'For a change to part of an existing file, use edit_file instead. Returns the file as it now reads. The ' +
      'user approves each write and may decline.',
    inputSchema: z.object({
      path: z.string().describe('File path, relative to the project folder, e.g. "TODOS.md"'),
      content: z.string().describe('The complete new content of the file'),
    }),
  }),
};

/** The client tools a request asked for, unknown names ignored. */
export function clientTools(names: unknown): ToolSet {
  if (!Array.isArray(names)) return {};
  return Object.fromEntries(Object.entries(CLIENT_TOOLS).filter(([name]) => names.includes(name)));
}

/** System prompt lines for a client that runs `shell` (and the file tools): where, and on what. */
export function shellPrompt(client: { cwd?: unknown; platform?: unknown; files?: boolean }): string {
  const where = typeof client.cwd === 'string' && client.cwd ? ` The folder is ${client.cwd}.` : '';
  const os = typeof client.platform === 'string' && client.platform ? ` The OS is ${client.platform}.` : '';
  const rules = [
    `You work in the user's project folder with tools.${where}${os} Commands start in that folder, so "this ` +
      'folder", "the project" and "here" mean it: use relative paths (ls, cat package.json), not system folders.',
    'Do exactly what the user asked, all of it. Never ask whether a file exists or what it says: look with ' +
      'read_file or ls. Do not ask the user to run commands you can run yourself.',
  ];
  if (client.files) {
    rules.push(
      'To change part of a file: read_file it, then edit_file with old_text copied exactly from it. Keep every ' +
        'line you were not asked to change, word for word.',
      'When the change touches many lines (turning a list into checkboxes, renumbering, reformatting): read_file, ' +
        'then write_file the complete new file in one call. If an edit_file fails twice, do that instead.',
      'To create a file or rewrite all of it: write_file with the complete content in one call. Never build ' +
        'or edit files with echo, sed, awk or perl.',
      'Each change returns the file as it now reads. Compare it with what the user asked; if it is wrong, fix ' +
        'it. Only then say it is done, and never say something is done if a result shows it failed.',
    );
  }
  rules.push(
    'Read each result before the next step. If the user declines a command or a change, do not retry it; ask ' +
      'what they want instead.',
  );
  return rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n');
}

/** The built-in tools whose keys are present, plus a line per tool for logs. */
export function builtinTools(env = process.env): { tools: ToolSet; report: string[] } {
  const tools: ToolSet = {};
  const report: string[] = [];

  if (env.OPENWEATHERMAP_API_KEY) {
    tools.weather = weatherTool(env.OPENWEATHERMAP_API_KEY);
    report.push('  ✓ tool weather (OpenWeatherMap)');
  } else {
    report.push('  · tool weather skipped: OPENWEATHERMAP_API_KEY not set');
  }

  if (env.FIRECRAWL_API_KEY) {
    tools.search = searchTool(env.FIRECRAWL_API_KEY, Number(env.SEARCH_MAX_CHARS) || 4000);
    report.push('  ✓ tool search (Firecrawl)');
  } else {
    report.push('  · tool search skipped: FIRECRAWL_API_KEY not set');
  }

  return { tools, report };
}
