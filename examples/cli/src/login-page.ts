// The page the browser lands on after `locci-chat login`. Self-contained (no
// network requests), in the web app's colours (examples/web layout.css), light
// or dark with the system, with the web app's logo inlined.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The Locci wordmark from the web example (examples/web/static), one file per
 * theme as in its Logo.svelte. Null if the files aren't there (the text
 * wordmark is used instead).
 */
function logo(theme: 'light' | 'dark'): string | null {
  try {
    const file = fileURLToPath(new URL(`../../web/static/logo-${theme}.png`, import.meta.url));
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

function wordmark(): string {
  const light = logo('light');
  const dark = logo('dark');
  if (!light || !dark) return '<div class="brand"><b>LOCCI</b><span>AI</span></div>';
  return `<div class="brand"><img class="logo light" src="${light}" alt="Locci" width="893" height="295"><img class="logo dark" src="${dark}" alt="" width="892" height="295"><span>AI</span></div>`;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CHECK = `<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="ring" cx="26" cy="26" r="24"/><path class="mark" d="M15 27l7 7 15-16"/></svg>`;
const CROSS = `<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="ring" cx="26" cy="26" r="24"/><path class="mark" d="M18 18l16 16M34 18L18 34"/></svg>`;

export function loginPage(result: { ok: true; email?: string } | { ok: false; reason: string }): string {
  const title = result.ok ? "You're signed in" : "Sign-in didn't finish";
  const detail = result.ok
    ? `${result.email ? `<p class="who"><span class="dot"></span>${escape(result.email)}</p>` : ''}
       <p>Head back to your terminal; the CLI has your session. You can close this tab.</p>
       <pre><span class="prompt">$</span> locci-chat chat</pre>`
    : `<p class="reason">${escape(result.reason)}</p>
       <p>Nothing was saved. Run the login again from your terminal.</p>
       <pre><span class="prompt">$</span> locci-chat login</pre>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Locci AI</title>
<style>
  :root {
    --bg: #ffffff; --fg: #18181b; --muted: #71717a; --border: #e4e4e7; --card: #fafafa;
    --accent: ${result.ok ? '#2563eb' : '#dc2626'}; --glow: ${result.ok ? 'rgba(37,99,235,.18)' : 'rgba(220,38,38,.16)'};
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0b0c; --fg: #ececed; --muted: #a1a1aa; --border: #27272a; --card: #131315;
      --accent: ${result.ok ? '#3b82f6' : '#ef4444'}; --glow: ${result.ok ? 'rgba(59,130,246,.22)' : 'rgba(239,68,68,.2)'};
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px;
    background: radial-gradient(60rem 30rem at 50% -10%, var(--glow), transparent 70%), var(--bg);
    color: var(--fg); font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main {
    width: 100%; max-width: 26rem; text-align: center; padding: 40px 28px 32px;
    background: var(--card); border: 1px solid var(--border); border-radius: 24px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 40px -12px var(--glow);
    animation: rise .5s cubic-bezier(.2,.8,.2,1) both;
  }
  .brand { display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 800; letter-spacing: .02em; font-size: 15px; margin-bottom: 28px; }
  .logo { height: 26px; width: auto; }
  .logo.dark { display: none; }
  @media (prefers-color-scheme: dark) { .logo.light { display: none; } .logo.dark { display: block; } }
  .brand b { text-decoration: underline; text-decoration-thickness: 3px; text-underline-offset: 3px; }
  .brand span { color: var(--muted); font-weight: 600; font-size: 17px; }
  svg { width: 72px; height: 72px; display: block; margin: 0 auto 20px; }
  .ring { fill: none; stroke: var(--accent); stroke-width: 2.5; opacity: .25; }
  .mark {
    fill: none; stroke: var(--accent); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round;
    stroke-dasharray: 48; stroke-dashoffset: 48; animation: draw .45s .35s ease-out forwards;
  }
  h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: -.02em; }
  p { margin: 0 0 14px; color: var(--muted); }
  .who {
    display: inline-flex; align-items: center; gap: 8px; color: var(--fg); font-weight: 500;
    border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; margin-bottom: 16px; max-width: 100%;
    overflow-wrap: anywhere;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex: none; box-shadow: 0 0 0 3px rgba(34,197,94,.2); }
  .reason { color: var(--fg); overflow-wrap: anywhere; }
  pre {
    margin: 18px 0 0; padding: 12px 14px; text-align: left; border-radius: 12px; overflow-x: auto;
    background: var(--bg); border: 1px solid var(--border); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .prompt { color: var(--accent); margin-right: 8px; user-select: none; }
  @keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    main { animation: none; }
    .mark { animation: none; stroke-dashoffset: 0; }
  }
</style>
</head>
<body>
<main>
  ${wordmark()}
  ${result.ok ? CHECK : CROSS}
  <h1>${title}</h1>
  ${detail}
</main>
</body>
</html>`;
}
