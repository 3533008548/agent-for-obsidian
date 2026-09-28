/**
 * Tray and hotkey behaviour that has no Electron dependency, so it can be
 * unit-tested without stubbing `require("electron")` (which only resolves to a
 * binary path outside the Electron runtime).
 */

/**
 * `CommandOrControl` is Electron's portable spelling: Cmd on macOS, Ctrl
 * elsewhere. Shift is in there because a bare Ctrl+letter collides with
 * browser-style shortcuts once focus is inside the window.
 */
export const DEFAULT_HOTKEY = "CommandOrControl+Shift+K";

/**
 * Tried in order until one registers. The first combination can already belong
 * to an IDE or an input method, and a hotkey that silently does nothing is
 * worse than no hotkey — the menu shows whichever one actually took effect.
 */
export const HOTKEY_CANDIDATES = [DEFAULT_HOTKEY, "CommandOrControl+Alt+K"] as const;

const MODIFIER_LABELS: Record<string, { darwin: string; other: string }> = {
  CommandOrControl: { darwin: "⌘", other: "Ctrl" },
  Cmd: { darwin: "⌘", other: "Ctrl" },
  Command: { darwin: "⌘", other: "Ctrl" },
  Control: { darwin: "⌃", other: "Ctrl" },
  Ctrl: { darwin: "⌃", other: "Ctrl" },
  Alt: { darwin: "⌥", other: "Alt" },
  Option: { darwin: "⌥", other: "Alt" },
  Shift: { darwin: "⇧", other: "Shift" },
  Meta: { darwin: "⌘", other: "Win" },
  Super: { darwin: "⌘", other: "Win" }
};

const DARWIN_KEY_LABELS: Record<string, string> = {
  Return: "↩",
  Enter: "↩",
  Escape: "⎋",
  Space: "空格",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→"
};

/**
 * Turns an Electron accelerator into something a human can read in a menu —
 * "CommandOrControl+Shift+K" becomes "⌘⇧K" or "Ctrl + Shift + K".
 */
export function describeAccelerator(
  accelerator: string,
  platform: NodeJS.Platform = process.platform
): string {
  const parts = accelerator.split("+").filter(Boolean);
  const isDarwin = platform === "darwin";
  const labels = parts.map((part) => {
    const modifier = MODIFIER_LABELS[part];
    if (modifier) {
      return isDarwin ? modifier.darwin : modifier.other;
    }
    if (isDarwin) {
      return DARWIN_KEY_LABELS[part] ?? part.toUpperCase();
    }
    return part.length === 1 ? part.toUpperCase() : part;
  });
  return isDarwin ? labels.join("") : labels.join(" + ");
}

/**
 * Closing the window parks the app in the tray instead of ending the process.
 * A tray-resident app that exits on window close is pointless — the whole
 * reason to have a tray is that the index and the model config stay warm.
 * macOS behaves this way by convention; on Windows and Linux it is a choice,
 * and the menu makes it explicit by offering "退出" as the only way out.
 */
export const CLOSE_HIDES_TO_TRAY = true;
