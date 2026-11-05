import type { ReportInput } from "./report.js";

interface UADataLike {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ platform?: string; platformVersion?: string; model?: string }>;
}

/** Best-effort OS name + version from a User-Agent string. */
export function osFromUserAgent(ua: string): string | undefined {
  let m: RegExpExecArray | null;
  if ((m = /(?:iPhone|CPU) OS (\d+(?:[_.]\d+)*)/.exec(ua))) return `iOS ${m[1]!.replace(/_/g, ".")}`;
  if ((m = /iPad.*OS (\d+(?:[_.]\d+)*)/.exec(ua))) return `iPadOS ${m[1]!.replace(/_/g, ".")}`;
  if ((m = /Android (\d+(?:\.\d+)*)/.exec(ua))) return `Android ${m[1]}`;
  if ((m = /Mac OS X (\d+(?:[_.]\d+)*)/.exec(ua))) return `macOS ${m[1]!.replace(/_/g, ".")}`;
  if ((m = /Windows NT (\d+(?:\.\d+)*)/.exec(ua))) return `Windows NT ${m[1]}`;
  if ((m = /CrOS \S+ (\d+(?:\.\d+)*)/.exec(ua))) return `ChromeOS ${m[1]}`;
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
}

const OS_NAMES: Record<string, string> = { macOS: "macOS", Windows: "Windows", Android: "Android", "Chrome OS": "ChromeOS", ChromeOS: "ChromeOS", Linux: "Linux", iOS: "iOS" };

/** os_version: UA Client Hints (platform + platformVersion) when available, else parsed from userAgent. */
export async function detectOsVersion(nav: Navigator | undefined = globalThis.navigator): Promise<string | undefined> {
  if (!nav) return undefined;
  const uad = (nav as Navigator & { userAgentData?: UADataLike }).userAgentData;
  if (uad?.getHighEntropyValues) {
    try {
      const v = await uad.getHighEntropyValues(["platformVersion"]);
      const name = v.platform ?? uad.platform;
      if (name && v.platformVersion) return `${OS_NAMES[name] ?? name} ${v.platformVersion}`;
    } catch {
      /* fall through */
    }
  }
  return osFromUserAgent(nav.userAgent ?? "");
}

/** Everything the report needs from the page, except id/prompt/time/screenshot. */
export async function collectPageMetadata(opts: { appId?: string; appVersion?: string; appBuild?: string }): Promise<
  Pick<ReportInput, "app" | "device" | "locale" | "context">
> {
  const w = typeof window !== "undefined" ? window : undefined;
  const loc = w?.location;
  const device: ReportInput["device"] = { platform: "web" };
  const os = await detectOsVersion();
  if (os) device.osVersion = os;
  if (w) device.screen = { width: w.innerWidth, height: w.innerHeight, scale: w.devicePixelRatio || 1 };
  const app: ReportInput["app"] = { id: opts.appId || loc?.host || loc?.protocol?.replace(/:$/, "") || "web" };
  if (opts.appVersion) app.version = opts.appVersion;
  if (opts.appBuild) app.build = opts.appBuild;
  const context: NonNullable<ReportInput["context"]> = {};
  if (loc?.href) context.url = loc.href;
  if (typeof document !== "undefined" && document.title) context.title = document.title;
  const out: Pick<ReportInput, "app" | "device" | "locale" | "context"> = { app, device, context };
  const locale = globalThis.navigator?.language;
  if (locale) out.locale = locale;
  return out;
}
