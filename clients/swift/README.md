# Fixr for Swift

SwiftPM package `Fixr` for iOS 17+ and macOS 14+. It has no dependencies. Users
press a shortcut or shake the device, draw black boxes over anything private
in a screenshot of the app, type what should change, and press Send. The
report goes to the fixr Worker as `POST /v1/reports`, following
[`spec/wire-format.md`](../../spec/wire-format.md).

> **Compile status.** This package was written on Linux. The
> platform-independent core builds there and is tested with `swift build` and
> `swift test`. The UIKit, AppKit, SwiftUI, CoreGraphics and background
> URLSession code in `Sources/Fixr/Apple/` and all of `Example/` has **not
> been compiled yet**. The Linux build parses those files (inactive `#if`
> blocks must still be valid syntax) but does not type-check them. Expect a few
> small fixes the first time it builds in Xcode. See
> [What is compiled where](#what-is-compiled-where).

## Install

```swift
.package(path: "../fixr/clients/swift")   // or a git URL
// target:
.product(name: "Fixr", package: "swift")
```

## Use

```swift
import Fixr

Fixr.configure(FixrConfiguration(
    endpoint: URL(string: "https://fixr.example.workers.dev")!,
    projectKey: "pk_…",
    trigger: [.keyboardShortcut, .shakeSwizzle],      // default: .keyboardShortcut
    metadataProvider: { ["branch": "main"] },          // merged into `extra`
    allowRedaction: true,
    maxImageDimension: 2000,                           // clamped to the wire limit
    maxImageBytes: 2_000_000                           // clamped to the wire limit
))

Fixr.present()                                         // capture + report sheet
try Fixr.send(prompt: "Title should be bold")          // no UI, fire and forget
try Fixr.send(prompt: "…", image: cgImage, extra: ["k": "v"])
Fixr.flush()                                           // upload the queue now, ignoring backoff
```

`send` checks the prompt (1 to 4000 Unicode scalars) and throws
`FixrError.notConfigured`, `.emptyPrompt` or `.promptTooLong`. The report is
written to the disk queue before `send` returns. The upload happens in the
background. `send` returns the report id, which is also the
`Idempotency-Key`.

`send(prompt:image:extra:)` accepts either a `CGImage` (Apple, which runs the
image ladder) or an already-encoded `FixrScreenshot(data:mime:)` (all
platforms).

### Background uploads (iOS)

Forward the app delegate callback so that uploads finished while the app was
suspended get processed:

```swift
func application(_ application: UIApplication,
                 handleEventsForBackgroundURLSession identifier: String,
                 completionHandler: @escaping () -> Void) {
    if !Fixr.handleEventsForBackgroundURLSession(identifier: identifier, completionHandler: completionHandler) {
        completionHandler()   // not Fixr's session
    }
}
```

## Triggers

| trigger             | platform | how                                                                 |
|---------------------|----------|---------------------------------------------------------------------|
| `.keyboardShortcut` | macOS    | app-local ⌘⇧F via `NSEvent.addLocalMonitorForEvents`. There is no global monitor because that needs the Accessibility permission. |
| `.shake`            | iOS      | opt-in. The app forwards shakes itself: `override func motionEnded(_ m: UIEvent.EventSubtype, with e: UIEvent?) { Fixr.handleMotion(m, with: e) }` |
| `.shakeSwizzle`     | iOS      | opt-in. Fixr swizzles `UIWindow.motionEnded(_:with:)`. It adds an override on `UIWindow` first, so other `UIResponder`s are untouched. A view controller that handles shakes without calling `super` stops the event before it reaches the window. |

Calling `Fixr.present()` from your own button always works.

## Capture

Neither platform needs the Screen Recording permission. The screenshot is
taken before the sheet appears.

- **iOS:** draws every visible window of the active `UIWindowScene`, sorted
  by `windowLevel`, with `drawHierarchy(in:afterScreenUpdates: false)` into one
  `UIGraphicsImageRenderer` image. Caveats:
  - A `CAMetalLayer`/`MTKView` renders black unless you set
    `framebufferOnly = false`.
  - The keyboard and status bar are not included.
- **macOS:** calls `CGWindowListCreateImage(.null, .optionIncludingWindow,
  keyWindow.windowNumber, [.boundsIgnoreFraming, .bestResolution])`. This
  returns composited pixels, so Metal, WKWebView and SwiftUI content all look
  right, and TCC does not gate capturing your own window.
  - The function is deprecated since macOS 14 and marked obsoleted in newer
    SDKs, so it is looked up with `dlsym` at runtime instead of being
    referenced at compile time.
  - If it is missing or returns a transparent image, capture falls back to
    `contentView.cacheDisplay(in:to:)`. That fallback misses Metal layers.

The image ladder is the same in every client:

1. Downscale so the long edge is at most 2000 px.
2. Try PNG.
3. Try JPEG at quality 0.9, 0.8, 0.7, 0.6 and 0.5.
4. If nothing fits, scale by ×0.75 and repeat from step 2.
5. Give up when the long edge drops below 200 px, and send
   `screenshot_omitted_reason: "too_large"`.

## UI

A SwiftUI sheet. On iOS it is a `UIHostingController` presented as a
`pageSheet`. On macOS it is an `NSPanel` attached with `beginSheet` to the key
window, or a standalone panel when there is no key window. The sheet has:

- a preview of the screenshot
- a drag-to-redact canvas that draws black rectangles
- a toggle to leave the screenshot out
- a prompt editor with a 4000-character counter
- Cancel (Esc) and Send (⌘↩) buttons

Redactions are burned into the pixels with `ImageRenderer`, with a
CoreGraphics fallback. If burning in fails, the report is sent without the
screenshot. The unredacted image is never sent.

`screenshot_omitted_reason` takes these values:

| value              | when                                    |
|--------------------|-----------------------------------------|
| `user_removed`     | the user turned the screenshot off      |
| `capture_failed`   | capture or encoding failed              |
| `too_large`        | the image ladder gave up                |
| `redaction_failed` | burning in the redactions failed        |

## Transport and queue

1. **Queue the report.** Each report is written to
   `Application Support/Fixr/queue/<id>/{report.json, screenshot.png|jpg, state.json}`.
   - The item is staged in a hidden directory and renamed into place, so a
     crash never leaves half an item.
   - `report.json` holds the exact bytes of the `report` part, so every
     retry sends the same document.
   - `state.json` holds `attempts`, `next_attempt_at` and `created_at`.
2. **Build the body.** The multipart body is written to `body.multipart`. It
   contains the `report` part, then the optional `screenshot` part with a
   `filename`.
3. **Upload.** The body file is sent with a background `URLSession`
   (`uploadTask(with:fromFile:)`, with `sessionSendsLaunchEvents` on iOS), so
   the upload survives suspension. Tasks that are still running after a
   relaunch are found with `getAllTasks` and are not started twice.
4. **Headers.** Every request carries `Authorization: Bearer <projectKey>`,
   `Idempotency-Key: <id>` and `User-Agent: fixr-swift/0.1.0`.
5. **Response handling.**
   - 201 and 200 (duplicate) delete the item.
   - 400, 401, 403, 413, 422 and every other 4xx drop it.
   - 408, 429, 5xx and network errors are retried after 30 s, 2 min, 10 min,
     1 h, 6 h, then every 24 h.
   - A longer `Retry-After` on a 429 or 503 overrides the next delay.
   - A report is dropped after 20 attempts or 7 days after `created_at`.
6. **When the queue drains.** On `configure`, on foreground or activation,
   after each completion, and on an in-process timer.
7. **Size limit.** If the body would exceed 2.5 MiB, the screenshot is
   dropped and the reason becomes `too_large`.
8. **Fallback.** If background uploads are off (`backgroundUploads: false`),
   or the process has no bundle identifier (CLI tools, tests), Fixr uses a
   plain foreground `URLSession` instead. Linux always uses that path through
   FoundationNetworking.

## Metadata

Each report carries:

- the bundle id, `CFBundleShortVersionString` and `CFBundleVersion`
- the OS version
- the device model: `hw.model` on macOS (e.g. `Mac15,6`), `utsname.machine`
  on iOS (the simulator reports the simulated model)
- the screen size in points and its scale
- the locale (`en-US`)
- `context.screen` and `context.title`: on iOS the top view controller's class
  and title, on macOS the key window's content view controller class and the
  window title
- the output of your `metadataProvider`, merged into `extra`. Values passed
  to `send` win on conflicts.

`extra` is clamped to 32 keys, keys of at most 64 characters, and values of
at most 1000 characters.

## Example app

`Example/` contains source only:

- `ContentView.swift`: a SwiftUI screen whose **Save button is deliberately
  misaligned** with Cancel. That is the bug to report.
- `MetalClearView.swift`: an `MTKView` with `framebufferOnly = false` that
  animates its clear colour. It proves that Metal content appears in the
  capture.
- `FixrExampleApp.swift`: `Fixr.configure` and the iOS app delegate
  forwarding.

Start the echo server from the repository root:

```sh
node spec/echo-server/server.mjs --port 8787
```

Run the example:

- **macOS:** `cd clients/swift/Example && swift run`, then press ⌘⇧F. Set
  `FIXR_ENDPOINT` and `FIXR_PROJECT_KEY` to point it elsewhere.
- **iOS:**
  1. Create an iOS App target in Xcode.
  2. Add this package as a local dependency.
  3. Replace the generated sources with the three files in
     `Example/Sources/FixrExample`.
  4. For `http://localhost`, add `NSAppTransportSecurity` →
     `NSAllowsLocalNetworking = YES` to Info.plist. On a device, use your
     Mac's LAN IP.
  5. Shake the device, or use Device ▸ Shake in the simulator.

## Tests

```sh
swift build
swift test
```

The tests run on Linux and macOS:

- `ReportTests`: the encoder output parses equal to
  `spec/fixtures/report.v1.json`. Also covers the decode round trip, optional
  members being omitted rather than `null`, the timestamp format, UUID v4 ids,
  and the prompt and `extra` limits.
- `MultipartTests`: exact bytes and part order, the boundary never colliding
  with content, and the JSON body variant.
- `DeliveryTests`: the response table, `Retry-After`, the retry schedule, and
  the attempt and age limits.
- `ImageLadderTests`: the ladder order, the downscale, the ×0.75 step and the
  200 px give-up, using a fake encoder.
- `DiskQueueTests`: the on-disk layout, persistence, junk and half-written
  items being ignored, and enqueue being idempotent per id.
- `UploaderTests` and `FixrFacadeTests`: headers, delivered/dropped/retry
  handling with a fake clock, flush, the 20-attempt and 7-day drops,
  oversized screenshots, and relaunch with in-flight tasks.
- `EchoServerIntegrationTests`: starts `node spec/echo-server/server.mjs`
  with `Process` on a random port and checks:
  - a real multipart upload with a screenshot, then the 200 duplicate
  - 503 → retry → 201
  - 401 → drop
  - the public `Fixr.configure`/`Fixr.send` path end to end

  These tests are **skipped** when `node` is not on `PATH`.

## What is compiled where

| file | Linux (`swift build`/`swift test`) | Apple |
|------|------------------------------------|-------|
| `Sources/Fixr/Core/*` | compiled + tested | compiled |
| `Sources/Fixr/Apple/BackgroundSessionTransport.swift` (`#if os(iOS) \|\| os(macOS)`) | parsed only | **not yet compiled** |
| `Sources/Fixr/Apple/ImageCodec.swift` (`#if canImport(CoreGraphics) && canImport(ImageIO)`): ladder encoder, `send(prompt:image: CGImage)` | parsed only | **not yet compiled** |
| `Sources/Fixr/Apple/ReportSheet.swift` (`#if canImport(SwiftUI) …`): sheet, redaction, `ImageRenderer` | parsed only | **not yet compiled** |
| `Sources/Fixr/Apple/Platform_iOS.swift` (`#if canImport(UIKit)`): capture, presenter, shake, `handleMotion` | parsed only | **not yet compiled** |
| `Sources/Fixr/Apple/Platform_macOS.swift` (`#if canImport(AppKit) && !canImport(UIKit)`): capture, presenter, ⌘⇧F | parsed only | **not yet compiled** |
| `Example/**` | not built | **not yet compiled** |

On Linux, `Fixr.present()` and the triggers do nothing.
