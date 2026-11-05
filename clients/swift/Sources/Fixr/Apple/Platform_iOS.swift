// Apple-only (not compiled on Linux): iOS / iPadOS / Mac Catalyst.
#if canImport(UIKit) && !os(watchOS)
import ObjectiveC
import SwiftUI
import UIKit

// MARK: - Capture

/// Draws every visible window of the active `UIWindowScene`, in window-level
/// order, into one image. No permission needed. Caveats: `CAMetalLayer`
/// content is black unless the host sets `framebufferOnly = false`; the
/// keyboard and status bar are not included.
@MainActor
enum WindowCapture {
    static func activeScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive }
            ?? scenes.first { $0.activationState == .foregroundInactive }
            ?? scenes.first
    }

    static func capture(scene: UIWindowScene? = activeScene()) -> CGImage? {
        guard let scene else { return nil }
        let windows = scene.windows.enumerated()
            .filter { !$0.element.isHidden && $0.element.alpha > 0.01 && !$0.element.bounds.isEmpty }
            .sorted { ($0.element.windowLevel.rawValue, $0.offset) < ($1.element.windowLevel.rawValue, $1.offset) }
            .map(\.element)
        guard !windows.isEmpty else { return nil }
        let bounds = scene.coordinateSpace.bounds
        let format = UIGraphicsImageRendererFormat()
        format.scale = scene.screen.scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
        var drew = false
        let image = renderer.image { context in
            UIColor.black.setFill()
            context.fill(bounds)
            for window in windows {
                if window.drawHierarchy(in: window.frame, afterScreenUpdates: false) { drew = true }
            }
        }
        return drew ? image.cgImage : nil
    }
}

// MARK: - Platform hooks

enum FixrPlatform {
    static func didConfigure(_ configuration: FixrConfiguration) {
        onMain {
            refreshSnapshot()
            if configuration.trigger.contains(.shakeSwizzle) { ShakeSwizzle.install() }
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
    static func refreshSnapshot() {
        let scene = WindowCapture.activeScene()
        if let screen = scene?.screen {
            PlatformSnapshot.shared.screen = Report.Screen(
                width: Int(screen.bounds.width.rounded()),
                height: Int(screen.bounds.height.rounded()),
                scale: Double(screen.scale)
            )
        }
        PlatformSnapshot.shared.context = currentContext(scene)
    }

    @MainActor
    static func currentContext(_ scene: UIWindowScene?) -> Report.Context? {
        guard let root = (scene?.keyWindow ?? scene?.windows.first)?.rootViewController else { return nil }
        let top = topViewController(root)
        var name = String(describing: type(of: top))
        if let generic = name.firstIndex(of: "<") { name = String(name[..<generic]) }
        var candidates: [String?] = [top.navigationItem.title, top.title]
        if let scene { candidates.append(scene.title) }
        let title = candidates.compactMap { $0 }.first { !$0.isEmpty }
        return Report.Context(screen: String(name.prefix(500)), title: title.map { String($0.prefix(500)) })
    }

    @MainActor
    static func topViewController(_ root: UIViewController) -> UIViewController {
        if let presented = root.presentedViewController, !presented.isBeingDismissed {
            return topViewController(presented)
        }
        if let nav = root as? UINavigationController, let visible = nav.visibleViewController {
            return topViewController(visible)
        }
        if let tabs = root as? UITabBarController, let selected = tabs.selectedViewController {
            return topViewController(selected)
        }
        return root
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
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { _ in
            FixrRuntime.shared.uploader?.drain()
        }
    }
}

// MARK: - Presentation

@MainActor
enum ReportPresenter {
    private static weak var presented: UIViewController?

    static func present(_ configuration: FixrConfiguration) {
        guard presented == nil, let scene = WindowCapture.activeScene(),
              let root = (scene.keyWindow ?? scene.windows.first)?.rootViewController else { return }
        FixrPlatform.refreshSnapshot()
        let context = PlatformSnapshot.shared.context
        // Capture before the sheet exists.
        let image = WindowCapture.capture(scene: scene)
        let model = ReportSheetModel(image: image, allowRedaction: configuration.allowRedaction)
        let host = UIHostingController(rootView: ReportSheetView(model: model))
        host.modalPresentationStyle = .pageSheet
        if let sheet = host.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        model.onCancel = { [weak host] in host?.dismiss(animated: true) }
        model.onSend = { [weak host] prompt, finalImage, reason in
            host?.dismiss(animated: true)
            FixrSubmission.submit(prompt: prompt, image: finalImage, omittedReason: reason,
                                  context: context, configuration: configuration)
        }
        presented = host
        FixrPlatform.topViewController(root).present(host, animated: true)
    }
}

// MARK: - Shake trigger

extension Fixr {
    /// Forward from a `motionEnded(_:with:)` override (e.g. in your root view
    /// controller or a `UIWindow` subclass) when `trigger` contains `.shake`.
    @MainActor
    public static func handleMotion(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake, let configuration = FixrRuntime.shared.configuration,
              !configuration.trigger.isDisjoint(with: [.shake, .shakeSwizzle]) else { return }
        present()
    }
}

@MainActor
private enum ShakeSwizzle {
    private static var installed = false

    /// Adds/exchanges `motionEnded(_:with:)` on `UIWindow` only. If UIWindow
    /// inherits the method from UIResponder, an override is added first so
    /// other responders are untouched.
    static func install() {
        guard !installed else { return }
        installed = true
        let cls: AnyClass = UIWindow.self
        let originalSelector = #selector(UIResponder.motionEnded(_:with:))
        let swizzledSelector = #selector(UIWindow.fixr_motionEnded(_:with:))
        guard let original = class_getInstanceMethod(cls, originalSelector),
              let swizzled = class_getInstanceMethod(cls, swizzledSelector) else { return }
        if class_addMethod(cls, originalSelector, method_getImplementation(swizzled), method_getTypeEncoding(swizzled)) {
            class_replaceMethod(cls, swizzledSelector, method_getImplementation(original), method_getTypeEncoding(original))
        } else {
            method_exchangeImplementations(original, swizzled)
        }
    }
}

extension UIWindow {
    @objc fileprivate func fixr_motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        fixr_motionEnded(motion, with: event) // the original implementation after swizzling
        Fixr.handleMotion(motion, with: event)
    }
}
#endif
