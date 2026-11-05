export interface Hotkey {
  key: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export function isMac(nav: Navigator | undefined = globalThis.navigator): boolean {
  const p = (nav as Navigator & { userAgentData?: { platform?: string } })?.userAgentData?.platform ?? nav?.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** "mod+shift+f" → mod is ⌘ on Apple platforms, Ctrl elsewhere. */
export function parseHotkey(spec: string, mac = isMac()): Hotkey {
  const hk: Hotkey = { key: "", meta: false, ctrl: false, shift: false, alt: false };
  for (const raw of spec.toLowerCase().split("+").map((s) => s.trim())) {
    if (raw === "mod") mac ? (hk.meta = true) : (hk.ctrl = true);
    else if (raw === "cmd" || raw === "meta") hk.meta = true;
    else if (raw === "ctrl" || raw === "control") hk.ctrl = true;
    else if (raw === "shift") hk.shift = true;
    else if (raw === "alt" || raw === "option") hk.alt = true;
    else hk.key = raw;
  }
  return hk;
}

export function matchesHotkey(e: KeyboardEvent, hk: Hotkey): boolean {
  if (e.metaKey !== hk.meta || e.ctrlKey !== hk.ctrl || e.shiftKey !== hk.shift || e.altKey !== hk.alt) return false;
  const key = (e.key ?? "").toLowerCase();
  if (key === hk.key) return true;
  // Layout-independent fallback for letters/digits (e.g. Alt changes e.key on macOS).
  const code = e.code ?? "";
  return (hk.key.length === 1 && (code === `Key${hk.key.toUpperCase()}` || code === `Digit${hk.key}`));
}
