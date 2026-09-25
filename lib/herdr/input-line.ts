/**
 * Pulls the agent's current input out of a rendered screen.
 *
 * Agent TUIs draw their prompt as a box (omp: `╭── status ──╮` / `│ text │` / `╰─ text ─╯`), or
 * as a bare prompt line (claude: `❯ text`). The box is walked from its bottom border upward so a
 * multi-line draft comes back whole, with the bottom border's inline text as the final line.
 * Returning null is a valid answer: the caller keeps whatever it already had.
 */
const BOTTOM_BORDER = /^\s*[╰└]\s*[─-]/;
const TOP_BORDER = /^\s*[╭┌]/;
const SIDE_ROW = /^\s*[│┃]/;
const HINT = /\b(esc|enter|tab|shift|ctrl|↑|↓|←|→)\b.*·|·\s*(esc|enter|tab|shift|ctrl)/i;
const PLACEHOLDER = /^(type (your )?(message|answer|prompt|something)[.…]*|ask anything[.…]*|how can i help[?]?)$/i;
/** Numbered rows belong to a picker/dialog, not the prompt box. */
const LIST_ROW = /^\d+[.)]\s/;
/** A bare prompt line (claude, and shells). */
const BARE_PROMPT = /^\s*[❯›»>]\s+?/;

/** Border plus the box's own padding (1-2 spaces) — not the author's indentation. */
function stripSide(row: string): string {
  return row.replace(/^\s*[│┃] {0,2}/, "").replace(/\s*[│┃]\s*$/, "");
}

function stripBottom(row: string): string {
  return row
    .replace(/^\s*[╰└]\s*[─-]{0,2}\s?/, "")
    .replace(/[\s─-]*[╯┘]\s*$/, "")
    .trim();
}

/** Everything between the top and bottom border of the prompt box, top row first. */
function readBox(lines: string[], bottomIndex: number): string[] | null {
  const bottom = stripBottom(lines[bottomIndex]);
  const collected: string[] = bottom ? [bottom] : [];
  for (let index = bottomIndex - 1; index >= 0; index--) {
    const row = lines[index];
    if (TOP_BORDER.test(row)) return collected.reverse();
    if (!SIDE_ROW.test(row)) return null;
    collected.push(stripSide(row).trimEnd());
  }
  return null;
}

export function extractInputLine(screen: string): string | null {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, ""));

  for (let index = lines.length - 1; index >= 0; index--) {
    const row = lines[index];
    if (HINT.test(row)) continue;
    // The box's own title/status row carries elapsed time and token counts, never input.
    if (TOP_BORDER.test(row)) continue;

    const isPlaceholder = (value: string) => {
      const withoutPrompt = value.trim().replace(BARE_PROMPT, "");
      return PLACEHOLDER.test(withoutPrompt) || LIST_ROW.test(withoutPrompt);
    };

    if (BOTTOM_BORDER.test(row)) {
      const box = readBox(lines, index);
      if (box) {
        const text = box.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
        if (!text.trim()) continue;
        if (isPlaceholder(text)) continue;
        return text;
      }
      continue;
    }

    const bare = BARE_PROMPT.exec(row);
    if (bare) {
      const text = row.slice(bare[0].length).trimEnd();
      if (!text) continue;
      if (PLACEHOLDER.test(text)) continue;
      return text;
    }
  }
  return null;
}
