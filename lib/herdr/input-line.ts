/**
 * Pulls the agent's current input out of a rendered screen.
 *
 * Agent TUIs draw their prompt as a box (omp: `╭── status ──╮` / `│ text │` / `╰─ text ─╯`), or
 * as a bare prompt line (claude: `❯ text`). The box is walked from its bottom border upward so a
 * multi-line draft comes back whole, with the bottom border's inline text as the final line.
 * Returning null is a valid answer: the caller keeps whatever it already had.
 *
 * The prompt is docked at the bottom of the pane, so the bottom-most box wins and the search
 * never continues past it. Everything above is transcript, and omp's welcome panel is shaped
 * exactly like a prompt box — walking up from an empty prompt used to serve its tips as a draft
 * (and mirroring that draft typed them into the agent).
 */
const BOTTOM_BORDER = /^\s*[╰└]\s*[─-]/;
/** A junction in the border means a multi-column panel (omp's welcome box), never the prompt. */
const PANEL_BORDER = /[┬┴├┤┼]/;
const TOP_BORDER = /^\s*[╭┌]/;
const SIDE_ROW = /^\s*[│┃]/;
const HINT = /\b(esc|enter|tab|shift|ctrl|↑|↓|←|→)\b.*·|·\s*(esc|enter|tab|shift|ctrl)/i;
/**
 * `Try "…"` is claude's greyed-out example prompt (its empty input). `pane.read` strips the ANSI
 * that makes it grey, so it is indistinguishable from a draft by colour — only by shape. A narrow
 * pane truncates it to `Try "…` with no closing quote.
 */
const PLACEHOLDER = /^(type (your )?(message|answer|prompt|something)[.…]*|ask anything[.…]*|how can i help[?]?|try\s?"[^"]*"?)$/i;
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
      // A panel border, or a box whose top never appears (the draft scrolled out of the read):
      // the prompt is not parseable here, and nothing higher up is the prompt either.
      if (PANEL_BORDER.test(row)) return null;
      const box = readBox(lines, index);
      if (!box) return null;
      const text = box.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
      if (!text.trim()) return null;
      if (isPlaceholder(text)) return null;
      return text;
    }

    const bare = BARE_PROMPT.exec(row);
    if (bare) {
      const text = row.slice(bare[0].length).trimEnd();
      if (!text) return null;
      if (PLACEHOLDER.test(text)) return null;
      return text;
    }
  }
  return null;
}
