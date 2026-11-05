import { describe, expect, it } from "vitest";
import { collectPageMetadata, osFromUserAgent } from "../src/metadata.js";
import { matchesHotkey, parseHotkey } from "../src/hotkey.js";

describe("metadata", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", "macOS 10.15.7"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Windows NT 10.0"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)", "iOS 17.4"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Android 14"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "Linux"],
  ])("parses %s", (ua, os) => {
    expect(osFromUserAgent(ua)).toBe(os);
  });

  it("collects platform web, screen, locale, url, title and app.id from location.host", async () => {
    document.title = "Doc 42";
    const m = await collectPageMetadata({ appVersion: "1.2.3" });
    expect(m.device.platform).toBe("web");
    expect(m.device.screen).toEqual({ width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio || 1 });
    expect(m.app).toEqual({ id: location.host, version: "1.2.3" });
    expect(m.context).toEqual({ url: location.href, title: "Doc 42" });
    expect(m.locale).toBe(navigator.language);
    expect(m.device.osVersion).toBe(osFromUserAgent(navigator.userAgent));
  });

  it("honours an explicit appId", async () => {
    expect((await collectPageMetadata({ appId: "com.example.web" })).app.id).toBe("com.example.web");
  });
});

describe("hotkey", () => {
  const ev = (o: Partial<KeyboardEvent>) => ({ key: "F", code: "KeyF", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent;
  it("mod is ⌘ on mac and Ctrl elsewhere", () => {
    expect(matchesHotkey(ev({ metaKey: true, shiftKey: true }), parseHotkey("mod+shift+f", true))).toBe(true);
    expect(matchesHotkey(ev({ ctrlKey: true, shiftKey: true }), parseHotkey("mod+shift+f", true))).toBe(false);
    expect(matchesHotkey(ev({ ctrlKey: true, shiftKey: true }), parseHotkey("mod+shift+f", false))).toBe(true);
    expect(matchesHotkey(ev({ ctrlKey: true }), parseHotkey("mod+shift+f", false))).toBe(false);
  });
});
