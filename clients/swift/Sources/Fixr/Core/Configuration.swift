import Foundation

/// How the report UI is opened besides calling `Fixr.present()` directly.
public struct FixrTrigger: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    /// iOS: shake opens the report sheet when the app forwards motion events
    /// with `Fixr.handleMotion(_:with:)`.
    public static let shake = FixrTrigger(rawValue: 1 << 0)
    /// iOS: like `.shake`, but Fixr swizzles `UIWindow.motionEnded(_:with:)`
    /// so the app needs no forwarding code.
    public static let shakeSwizzle = FixrTrigger(rawValue: 1 << 1)
    /// macOS: app-local ⌘⇧F (`NSEvent.addLocalMonitorForEvents`; only while
    /// the app is active, no Accessibility permission needed).
    public static let keyboardShortcut = FixrTrigger(rawValue: 1 << 2)

    public static let none: FixrTrigger = []
}

public struct FixrConfiguration: Sendable {
    /// Worker base URL, e.g. `https://fixr.example.workers.dev`. `/v1/reports`
    /// is appended unless already present.
    public var endpoint: URL
    public var projectKey: String
    public var trigger: FixrTrigger
    /// Extra string metadata merged into `extra` for every report (values
    /// passed to `send(prompt:image:extra:)` win on conflicts).
    public var metadataProvider: (@Sendable () -> [String: String])?
    /// Show the black-rectangle redaction tool in the report sheet.
    public var allowRedaction: Bool
    /// Long-edge limit for screenshots, clamped to 2000.
    public var maxImageDimension: Int
    /// Byte limit for screenshots, clamped to 2 000 000.
    public var maxImageBytes: Int
    /// Upload with a background `URLSession` (Apple platforms, bundled apps).
    public var backgroundUploads: Bool
    /// Queue location; defaults to `Application Support/Fixr/queue`.
    public var queueDirectory: URL?

    public init(
        endpoint: URL,
        projectKey: String,
        trigger: FixrTrigger = .keyboardShortcut,
        metadataProvider: (@Sendable () -> [String: String])? = nil,
        allowRedaction: Bool = true,
        maxImageDimension: Int = FixrLimits.imageMaxDimension,
        maxImageBytes: Int = FixrLimits.imageMaxBytes,
        backgroundUploads: Bool = true,
        queueDirectory: URL? = nil
    ) {
        self.endpoint = endpoint
        self.projectKey = projectKey
        self.trigger = trigger
        self.metadataProvider = metadataProvider
        self.allowRedaction = allowRedaction
        self.maxImageDimension = min(max(1, maxImageDimension), FixrLimits.imageMaxDimension)
        self.maxImageBytes = min(max(1, maxImageBytes), FixrLimits.imageMaxBytes)
        self.backgroundUploads = backgroundUploads
        self.queueDirectory = queueDirectory
    }
}
