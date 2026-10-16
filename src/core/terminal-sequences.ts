/**
 * Terminal control-sequence stripping.
 *
 * A framework-independent port of pi-tui's `stripTerminalSequences`, kept
 * in core so the ask tool can sanitize model-supplied text without
 * importing a host package.  Only ESC-initiated sequences are recognized —
 * CSI (`ESC [` … final), OSC (`ESC ]` … BEL/ST), and APC (`ESC _` … BEL/ST);
 * bare C0 controls and every other byte pass through unchanged.
 *
 * @module
 */

/**
 * The ANSI sequence starting at `pos`, or `null` when none begins there.
 *
 * CSI sequences run to the first `m`/`G`/`K`/`H`/`J` final (cursor-motion
 * finals `A`/`B`/`C`/`D` are intentionally not matched, mirroring pi-tui);
 * OSC and APC sequences run to BEL (`\x07`) or ST (`ESC \`).  An
 * unterminated sequence yields `null`, so its bytes are preserved.
 */
function extractAnsiCode(
  str: string,
  pos: number,
): { code: string; length: number } | null {
  if (pos >= str.length || str[pos] !== "\x1b") return null;
  const next = str[pos + 1];

  if (next === "[") {
    let j = pos + 2;
    while (j < str.length && !/[mGKHJ]/.test(str[j])) j++;
    if (j < str.length) {
      return { code: str.substring(pos, j + 1), length: j + 1 - pos };
    }
    return null;
  }

  if (next === "]" || next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") {
        return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      }
      if (str[j] === "\x1b" && str[j + 1] === "\\") {
        return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      }
      j++;
    }
    return null;
  }

  return null;
}

/**
 * Remove ANSI, OSC, and APC control sequences while preserving visible text.
 *
 * @param text - The text to sanitize.
 * @returns The text with recognized escape sequences removed.
 */
export function stripTerminalSequences(text: string): string {
  if (!text.includes("\x1b")) return text;
  let result = "";
  let i = 0;
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}
