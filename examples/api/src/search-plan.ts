import { generateText, type LanguageModel, type UIMessage } from 'ai';

/**
 * Plans the web search for a chat turn: the model reads the last few turns and
 * writes one self-contained query, or NONE. Searching the user's raw words
 * fails on follow-ups ("give me another example", "what about the second one?"):
 * the results are unrelated and crowd the context window. Writing a query from
 * the conversation is a far easier task for a 1.7B model than deciding on its
 * own to call a tool, which it does unreliably.
 */

const PLAN_TURNS = 6;
const PLAN_TURN_CHARS = 600;
const QUERY_MAX = 120;

function plannerPrompt(now: Date): string {
  return [
    `You write web search queries. Today is ${now.toISOString().slice(0, 10)}.`,
    'You get a short conversation. Write ONE search query for the LAST user message, or the word NONE. Do not answer the user.',
    'Write a query (3 to 8 words, naming the library, product or topic) for anything about facts, software, how-to, versions, news, people, companies, products or prices.',
    'Replace it / that / this / the second one with what it refers to.',
    'Lines starting "Searched:" are searches already made, with the pages found. If they already cover the last message, write NONE. If something is missing, search only for the missing part.',
    'Write NONE for greetings, the weather, or requests to rewrite, shorten, reformat or translate.',
  ].join('\n');
}

/** Worked examples: small models follow these far better than instructions alone. */
const EXAMPLES: [string, string][] = [
  ['User: How do I parse JSON in Go?', 'go parse json encoding/json example'],
  ['User: hey there!', 'NONE'],
  ['User: Teach me the Tokio runtime in Rust\nAssistant: Tokio is an async runtime. Add tokio to Cargo.toml...\nUser: show me another example', 'tokio rust async runtime example'],
  ['User: Which Python web frameworks are popular?\nAssistant: 1. Django 2. Flask 3. FastAPI\nUser: tell me more about the third one', 'FastAPI python web framework'],
  ['User: Explain Docker volumes\nAssistant: A volume stores data outside the container...\nUser: make that shorter', 'NONE'],
  ['User: Who is the CEO of Nvidia?', 'Nvidia CEO'],
  ['User: What is the weather in Paris?', 'NONE'],
  [
    'User: How do I make HTTP requests with axios?\nSearched: axios http requests tutorial (found: Axios docs, Getting started; Axios GET and POST examples)\nAssistant: Install axios, then call axios.get(url)...\nUser: show me a POST example',
    'NONE',
  ],
  [
    'User: How do I make HTTP requests with axios?\nSearched: axios http requests tutorial (found: Axios docs, Getting started; Axios GET and POST examples)\nAssistant: Install axios, then call axios.get(url)...\nUser: how do I set a timeout and retry failed requests?',
    'axios timeout retry interceptor',
  ],
];

type SearchPart = {
  type: string;
  state?: string;
  input?: { query?: string };
  output?: { results?: { title?: string; url?: string; description?: string; content?: string }[] };
};

type EarlierSearch = { query: string; titles: string[]; text: string };

/** Searches already made in this conversation: the query, the titles found, and all the text returned. */
export function earlierSearches(messages: UIMessage[]): EarlierSearch[] {
  return messages.flatMap((m) =>
    m.role !== 'assistant' ? [] : m.parts.flatMap((p) => searchOf(p as SearchPart) ?? []),
  );
}

function searchOf(part: SearchPart): EarlierSearch | null {
  if (part.type !== 'tool-search' || part.state !== 'output-available' || !part.input?.query) return null;
  const results = part.output?.results ?? [];
  const titles = results.map((r) => r.title ?? '').filter(Boolean);
  const text = results.map((r) => `${r.title ?? ''} ${r.url ?? ''} ${r.description ?? ''} ${r.content ?? ''}`).join(' ');
  return { query: part.input.query, titles, text };
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && !p.text.startsWith('<attachment '))
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The conversation's last turns as a short transcript, latest message last.
 * Searches show as "Searched: query (found: titles)", so the planner can tell
 * what the conversation already knows.
 */
function transcript(messages: UIMessage[]): string {
  return messages
    .slice(-PLAN_TURNS)
    .flatMap((m) => {
      const lines: string[] = [];
      if (m.role === 'assistant') {
        for (const part of m.parts) {
          const search = searchOf(part as SearchPart);
          if (!search) continue;
          const found = search.titles.length ? search.titles.slice(0, 3).join('; ') : 'nothing relevant';
          lines.push(`Searched: ${search.query} (found: ${found})`);
        }
      }
      const text = textOf(m);
      if (text) {
        const clipped = text.length > PLAN_TURN_CHARS ? `${text.slice(0, PLAN_TURN_CHARS)}…` : text;
        lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${clipped}`);
      }
      return lines;
    })
    .join('\n');
}

// Words that shape a query but say nothing about what is missing.
const GENERIC = new Set(
  'example examples tutorial tutorials guide guides docs documentation detailed detail explain explanation learn more basic basics intro introduction overview how'.split(
    ' ',
  ),
);

const stem = (w: string) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);

/**
 * Whether earlier searches already cover a planned query: every topic word in
 * it appears in an earlier query or in the results that came back, which are
 * still in the conversation the model answers from. The small model writes a
 * fresh query for nearly every follow-up ("show me a POST example" after a
 * reqwest tutorial search) and can't judge coverage itself, so this is checked
 * in code. A question about something new ("configure a proxy") has a word the
 * earlier results lack, and searches.
 */
export function coveredByEarlier(query: string, earlier: EarlierSearch[]): boolean {
  if (earlier.length === 0) return false;
  const wanted = [...keywords(query)].filter((w) => !GENERIC.has(w)).map(stem);
  if (wanted.length === 0) return false;
  const known = new Set([...keywords(earlier.map((s) => `${s.query} ${s.text}`).join(' '))].map(stem));
  return wanted.every((w) => known.has(w));
}

// Requests the planner over-searches, caught by wording before it runs.
const WEATHER = /\b(weather|forecast|temperature|raining|humid(ity)?)\b/i;
const TRANSLATE = /\btranslat(e|ion)\b/i;
const TRANSFORM =
  /^\s*(please\s+)?(can you\s+)?(make|rewrite|rephrase|reword|shorten|simplify|expand|reformat|format|fix|correct|summari[sz]e|condense|turn|convert)\b/i;
const REFERS_BACK = /\b(it|that|this|these|those|above|your (answer|reply|response)|the (text|previous|last) )/i;

/**
 * Whether the latest message clearly needs no search: the weather (its own
 * tool answers it), a translation, or reworking text already in the chat
 * ("make that shorter"). "Summarise the latest news" still searches.
 */
export function clearlyNoSearch(ask: string, opts: { weatherTool: boolean; hasHistory: boolean }): boolean {
  if (opts.weatherTool && WEATHER.test(ask)) return true;
  if (TRANSLATE.test(ask)) return true;
  return opts.hasHistory && TRANSFORM.test(ask) && REFERS_BACK.test(ask);
}

/** A search query for the latest turn, or null when no search is needed (or planning failed). */
export async function planSearchQuery(
  model: LanguageModel,
  messages: UIMessage[],
  { now = new Date(), tag = '', abortSignal }: { now?: Date; tag?: string; abortSignal?: AbortSignal } = {},
): Promise<string | null> {
  try {
    const { text } = await generateText({
      model,
      system: plannerPrompt(now),
      messages: [
        ...EXAMPLES.flatMap(([conversation, query]) => [
          { role: 'user' as const, content: conversation },
          { role: 'assistant' as const, content: query },
        ]),
        { role: 'user', content: transcript(messages) },
      ],
      maxOutputTokens: 32,
      temperature: 0,
      abortSignal,
    });
    const line = (text.split('\n').find((l) => l.trim()) ?? '')
      .replace(/^[\s\-*"'`]+|["'`.\s]+$/g, '')
      .replace(/^(search( query)?|query)\s*:\s*/i, '')
      .trim();
    if (!line || /^none\b/i.test(line)) return null;
    const query = line.slice(0, QUERY_MAX);
    if (coveredByEarlier(query, earlierSearches(messages))) {
      console.log(`  ${tag}[search] "${query}" is covered by earlier results; skipped`);
      return null;
    }
    return query;
  } catch (error) {
    console.error(`${tag}[search plan]`, error instanceof Error ? error.message : error);
    return null;
  }
}

// --- Relevance filter ---------------------------------------------------------

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how in into is it its of on or that the this to use using what when where which who why with your you'.split(
    ' ',
  ),
);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9.+#-]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

type SearchOutput = { query?: string; results?: { title?: string; url?: string; description?: string; content?: string }[] };

/**
 * Drops results that share no keyword with the query, so an off-target page
 * doesn't take a share of the context window. If nothing matches, the results
 * come back empty and the system prompt has the model say so.
 */
export function relevantResults<T>(query: string, output: T): T {
  const out = output as SearchOutput;
  if (!out || !Array.isArray(out.results)) return output;
  const wanted = keywords(query);
  if (wanted.size === 0) return output;
  const results = out.results.filter((r) => {
    const have = keywords(`${r.title ?? ''} ${r.url ?? ''} ${r.description ?? ''} ${(r.content ?? '').slice(0, 500)}`);
    for (const w of wanted) if (have.has(w)) return true;
    return false;
  });
  return { ...out, results } as T;
}
