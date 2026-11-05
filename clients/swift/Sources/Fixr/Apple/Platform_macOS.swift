// Apple-only (not compiled on Linux): macOS (AppKit, not Mac Catalyst).
#if canImport(AppKit) && !canImport(UIKit)
import AppKit
import Darwin
import SwiftUI

// MARK: - Capture

/// Captures the app's own key window. `CGWindowListCreateImage` with
/// `.optionIncludingWindow` returns composited pixels (Metal, WKWebView and
/// SwiftUI are correct) and TCC does not gate capturing your own window. It is
/// deprecated since macOS 14 and marked obsoleted in the macOS 15 SDK, so it
/// is resolved at runtime with `dlsym` rather than referenced at compile
/// time. Falls back to `cacheDisplay` when it is missing or returns a
/// transparent image.
@MainActor
enum WindowCapture {
    private typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    private static let createImage: CreateImage? = {
        guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY),
              let symbol = dlsym(handle, "CGWindowListCreateImage") else { return nil }
        return unsafeBitCast(symbol, to: CreateImage.self)
    }()

    // Raw values of kCGWindowListOptionIncludingWindow, kCGWindowImageBoundsIgnoreFraming
    // and kCGWindowImageBestResolution, so no deprecated symbol is referenced.
    private static let optionIncludingWindow: UInt32 = 1 << 3
    private static let boundsIgnoreFraming: UInt32 = 1 << 0
    private static let bestResolution: UInt32 = 1 << 3

    static func capture(_ window: NSWindow?) -> CGImage? {
        guard let window else { return nil }
        if window.windowNumber > 0, let createImage,
           let image = createImage(
               .null,
               optionIncludingWindow,
               UInt32(window.windowNumber),
               boundsIgnoreFraming | bestResolution
           )?.takeRetainedValue(),
           image.width > 1, image.height > 1, !ImageCodec.isFullyTransparent(image) {
            return image
        }
        return cacheDisplay(window)
    }

    /// Renders the content view through AppKit. Misses layer content that is
    /// not drawn by AppKit (Metal, some video), but needs nothing special.
    static func cacheDisplay(_ window: NSWindow) -> CGImage? {
        guard let view = window.contentView, !view.bounds.isEmpty,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep.cgImage
    }
}

// MARK: - Platform hooks

enum FixrPlatform {
    static func didConfigure(_ configuration: FixrConfiguration) {
        onMain {
            refreshSnapshot()
            ShortcutMonitor.update(enabled: configuration.trigger.contains(.keyboardShortcut))
            ForegroundObserver.install()
        }
    }

    static func refreshSnapshotIfOnMain() {
        if Thread.isMainThread { MainActor.assumeIsolated { refreshSnapshot() } }
    }

    @MainActor
    static func present(_ configuration: FixrConfiguration) {
        ReportPresenter.present(configuration)
    }

    @MainActor
    static func activeWindow() -> NSWindow? {
        guard let app = NSApp else { return nil }
        return app.keyWindow ?? app.mainWindow
    }

    @MainActor
    static func refreshSnapshot() {
        let window = activeWindow()
        if let screen = window?.screen ?? NSScreen.main {
            PlatformSnapshot.shared.screen = Report.Screen(
                width: Int(screen.frame.width.rounded()),
                height: Int(screen.frame.height.rounded()),
                scale: Double(screen.backingScaleFactor)
            )
        }
        guard let window else {
            PlatformSnapshot.shared.context = nil
            return
        }
        var name = window.contentViewController.map { String(describing: type(of: $0)) }
            ?? String(describing: type(of: window))
        if let generic = name.firstIndex(of: "<") { name = String(name[..<generic]) }
        let title = window.title.isEmpty ? nil : String(window.title.prefix(500))
        PlatformSnapshot.shared.context = Report.Context(screen: String(name.prefix(500)), title: title)
    }

    static func onMain(_ body: @escaping @MainActor () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { body() }
        } else {
            DispatchQueue.main.async { MainActor.assumeIsolated { body() } }
        }
    }
}

@MainActor
private enum ForegroundObserver {
    private static var token: NSObjectProtocol?

    static func install() {
        guard token == nil else { return }
        token = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            FixrRuntime.shared.uploader?.drain()
        }
    }
}

/// App-local ⌘⇧F. A global monitor would need Accessibility permission.
@MainActor
private enum ShortcutMonitor {
    private static var monitor: Any?

    static func update(enabled: Bool) {
        if enabled, monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                    .subtracting([.capsLock, .numericPad, .function])
                guard flags == [.command, .shift],
                      event.charactersIgnoringModifiers?.lowercased() == "f" else { return event }
                MainActor.assumeIsolated { Fixr.present() }
                return nil
            }
        } else if !enabled, let existing = monitor {
            NSEvent.removeMonitor(existing)
            monitor = nil
        }
    }
}

// MARK: - Presentation

/// Shows the report UI as a sheet on the key window (`beginSheet`), or as a
/// standalone panel when there is no window.
@MainActor
enum ReportPresenter {
    private static var panel: NSPanel?
    private static var closeObserver: NSObjectProtocol?

    static func present(_ configuration: FixrConfiguration) {
        if let panel {
            panel.makeKeyAndOrderFront(nil)
            return
        }
        FixrPlatform.refreshSnapshot()
        let context = PlatformSnapshot.shared.context
        let parent = FixrPlatform.activeWindow()
        // Capture before the sheet exists.
        let image = WindowCapture.capture(parent)
        let model = ReportSheetModel(image: image, allowRedaction: configuration.allowRedaction)
        let host = NSHostingController(rootView: ReportSheetView(model: model))
        let style: NSWindow.StyleMask = parent == nil ? [.titled, .closable, .resizable] : [.titled, .resizable]
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 560),
                            styleMask: style, backing: .buffered, defer: false)
        panel.title = "Report a problem"
        panel.isReleasedWhenClosed = false
        panel.contentViewController = host
        panel.setContentSize(NSSize(width: 640, height: 560))
        self.panel = panel

        let close: @MainActor () -> Void = { [weak parent, weak model] in
            if let parent, parent.attachedSheet === panel {
                parent.endSheet(panel)
            } else {
                panel.close()
            }
            model?.onSend = { _, _, _ in }
            model?.onCancel = {}
            ReportPresenter.finish()
        }
        model.onCancel = close
        model.onSend = { prompt, finalImage, reason in
            close()
            FixrSubmission.submit(prompt: prompt, image: finalImage, omittedReason: reason,
                                  context: context, configuration: configuration)
        }

        if let parent {
            parent.beginSheet(panel)
        } else {
            closeObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.willCloseNotification, object: panel, queue: .main
            ) { _ in
                MainActor.assumeIsolated { ReportPresenter.finish() }
            }
            panel.center()
            panel.makeKeyAndOrderFront(nil)
            NSApp?.activate()
        }
    }

    private static func finish() {
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        closeObserver = nil
        panel = nil
    }
}
#endif
