/**
 * Runnable check for the input-line parser: `bun run check`.
 * The box shapes are copied from real omp and claude screens.
 */
import assert from "node:assert/strict";
import { extractInputLine } from "../lib/herdr/input-line";

const cases: Array<[string, string, string | null]> = [
  [
    "omp single-line box",
    [
      "  ╭── 󰗏 15s  DeepSeek V4.1 Flash  …Board ────68%──────1M───╮",
      "╰─ mirror probe 42                                                                    ─╯",
      "  ○ 🐴 ponytail: ⚡ FULL",
    ].join("\n"),
    "mirror probe 42",
  ],
  [
    "omp multi-line box keeps every line and the bottom-border tail",
    [
      "  ╭── 󰗏 15s  DeepSeek V4.1 Flash  …Board ────68%──────1M───╮",
      "│  bug: some time, it sync wrong text from herdr to    │",
      "│  web input field (like ⟨Wall: 0.24s | Timeout:       │",
      "│  180s⟩)                                              │",
      "│  bug: multiline input field in herdr only sync last  │",
      "╰─ line to web                                         ─╯",
      "  ○ 🐴 ponytail: ⚡ FULL",
    ].join("\n"),
    [
      "bug: some time, it sync wrong text from herdr to",
      "web input field (like ⟨Wall: 0.24s | Timeout:",
      "180s⟩)",
      "bug: multiline input field in herdr only sync last",
      "line to web",
    ].join("\n"),
  ],
  ["omp empty box", ["╭── model ─╮", "╰─                    ─╯"].join("\n"), null],
  // Copied from a real omp welcome screen (`herdr pane read`): the welcome panel is shaped like a
  // prompt box, and the empty prompt below it used to send its tips through as the input line.
  [
    "welcome panel above an empty prompt is not input",
    [
      "╭─── omp v18.3.0 ───────────────────────────────────────────────────╮",
      "│                          │ Tips                                   │",
      "│      Welcome back!       │ # for prompt actions                   │",
      "│                          │ / for commands                         │",
      "│       ████████████       │ ! to run bash                          │",
      "│          ██  ██          │ $ to run python                        │",
      "│   DeepSeek V4.1 Flash    │ LSP Servers                            │",
      "│       commandcode        │ No LSP servers                         │",
      "╰──────────────────────────┴───────────────────────────────────────╯",
      " Tip: Press ← ← to drill into a running or finished agent",
      "",
      " Ponytail loaded: full",
      "",
      "──────────────────────────────────────────────────────────────────────",
      " Update Available",
      " New version 18.3.2 is available. Run: omp update",
      "──────────────────────────────────────────────────────────────────────",
      "",
      "╭── 󰵗   DeepSeek V4.1 Flash   /tmp ─0.6%────────────────────󰁨──────1M───╮",
      "╰─                                                                         ─╯",
      "○ 🐴 ponytail: ⚡ FULL",
    ].join("\n"),
    null,
  ],
  [
    "welcome panel above a draft returns only the draft",
    [
      "╭─── omp v18.3.0 ───────────────────────────────────────────────────╮",
      "│      Welcome back!       │ # for prompt actions                   │",
      "╰──────────────────────────┴───────────────────────────────────────╯",
      "╭── 󰵗   DeepSeek V4.1 Flash   /tmp ─0.6%────────────────────󰁨──────1M───╮",
      "│  fix the welcome-panel sync                                                     │",
      "╰─                                                                         ─╯",
      "○ 🐴 ponytail: ⚡ FULL",
    ].join("\n"),
    "fix the welcome-panel sync",
  ],
  ["claude prompt line", ["✻ Worked for 12s", "", "❯ add a changelog entry"].join("\n"), "add a changelog entry"],
  ["boxed prompt with side borders", ["╭──────────╮", "│ > run the tests │", "╰──────────╯"].join("\n"), "> run the tests"],
  [
    "key-hint footer is not input",
    ["╰─              ─╯", "Space toggle · Enter submit · ↑/↓ move · Tab/←/→ …"].join("\n"),
    null,
  ],
  ["placeholder is not input", ["╭──────────╮", "│ > Type your message… │", "╰──────────╯"].join("\n"), null],
  ["plain output is not input", ["  ⎿  Read src/index.ts (120 lines)", "  ⎿  Bash: bun test"].join("\n"), null],
  [
    "dialog option rows are not input",
    ["│  1. Commit in the submodule + PR │", "  2. File issue, don't edit", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n"),
    null,
  ],
  ["only box drawing", ["╭──────────────────╮", "╰──────────────────╯"].join("\n"), null],
  [
    "tool status line is not input",
    ["  ⟨Wall: 0.24s | Timeout: 180s⟩", "  ○ 🐴 ponytail: ⚡ FULL"].join("\n"),
    null,
  ],
];

let failures = 0;
for (const [name, screen, expected] of cases) {
  const actual = extractInputLine(screen);
  try {
    assert.deepEqual(actual, expected);
    console.log(`ok   ${name}`);
  } catch {
    failures += 1;
    console.error(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures === 0 ? 0 : 1);
