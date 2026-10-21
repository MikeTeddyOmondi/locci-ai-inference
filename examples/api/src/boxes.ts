import type { Tool, ToolSet } from 'ai';

/**
 * loccibox's agent boxes for the web chat. The MCP server runs with this API's
 * one loccibox key, so to loccibox every web user is the same owner: user A
 * could reach user B's box by its id, and box_list would show them all. Here
 * each signed-in user may use only the boxes created in their own chats.
 *
 * The record lives in this process: after an API restart a box from before is
 * "not found" and the model creates a new one. A loccibox key per user would
 * make loccibox enforce it instead (BACKLOG).
 */

/** The box tools the web chat offers by default; box_list is left out (it lists every user's boxes). */
export const WEB_BOX_TOOLS = ['box_create', 'box_exec', 'box_write_file', 'box_read_file', 'box_stop'];

const owned = new Map<string, Set<string>>();

/** The text of an MCP tool result. */
function resultText(output: unknown): string {
  const content = (output as { content?: { type: string; text?: string }[] })?.content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('\n');
  return typeof output === 'string' ? output : JSON.stringify(output ?? '');
}

const notYours = (boxId: string) => ({
  content: [{ type: 'text', text: `Box ${boxId} not found. Create a new one with box_create.` }],
  isError: true,
});

/**
 * The tool set with box tools limited to `owner`'s boxes. A box_create without
 * a box_id records the new box; with one (reattach), and every other box tool,
 * needs a box this owner created. Tools that are not box tools pass through.
 */
export function boxesFor(tools: ToolSet | undefined, owner: string): ToolSet | undefined {
  if (!tools) return tools;
  const mine = owned.get(owner) ?? new Set<string>();
  owned.set(owner, mine);
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!name.startsWith('box_') || !t.execute) {
      out[name] = t;
      continue;
    }
    const execute = t.execute;
    out[name] = {
      ...t,
      execute: async (input: { box_id?: string; remove?: boolean }, options) => {
        const id = input?.box_id;
        if (id && !mine.has(id)) return notYours(id);
        const output = await execute(input, options);
        if (name === 'box_create' && !id) {
          const created = /"box_id":\s*"(box_[\w-]+)"/.exec(resultText(output))?.[1];
          if (created) mine.add(created);
        }
        if (name === 'box_stop' && id && input.remove) mine.delete(id);
        return output;
      },
    } as Tool;
  }
  return out;
}
