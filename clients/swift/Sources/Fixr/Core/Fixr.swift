import Foundation

/// Entry point. Configure once at launch:
///
/// ```swift
/// Fixr.configure(FixrConfiguration(endpoint: URL(string: "https://fixr.example.workers.dev")!,
///                                  projectKey: "pk_..."))
/// ```
public enum Fixr {
    public static let sdkName = "fixr-swift"
    public static let sdkVersion = "0.1.0"
    public static let userAgent = "fixr-swift/0.1.0"

    /// Configures the SDK, installs triggers and drains any queued reports.
    /// Calling it again replaces the configuration.
    public static func configure(_ configuration: FixrConfiguration) {
        configure(configuration, transport: nil, clock: SystemClock(), schedulesRetries: true)
    }

    public static var isConfigured: Bool { FixrRuntime.shared.configuration != nil }

    /// Captures the app's own window and shows the report sheet (Apple
    /// platforms). No-op where there is no UI layer.
    @MainActor
    public static func present() {
        guard let configuration = FixrRuntime.shared.configuration else { return }
        FixrPlatform.present(configuration)
    }

    /// Queues a report without UI and uploads it in the background (fire and
    /// forget). Returns the report id. Throws for an empty or over-long prompt
    /// or when not configured.
    @discardableResult
    public static func send(prompt: String, image: FixrScreenshot? = nil, extra: [String: String] = [:]) throws -> String {
        try submit(prompt: prompt, screenshot: image, omittedReason: nil, extra: extra)
    }

    /// Uploads every queued report now, ignoring backoff delays.
    public static func flush() {
        FixrRuntime.shared.uploader?.drain(force: true)
    }

    /// Forward from `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
    /// Returns false (without calling the handler) when the session is not Fixr's.
    @discardableResult
    public static func handleEventsForBackgroundURLSession(identifier: String,
                                                           completionHandler: @escaping () -> Void) -> Bool {
        #if os(iOS) || os(macOS)
        guard identifier.hasPrefix(BackgroundSessionTransport.identifierPrefix) else { return false }
        BackgroundSessionTransport.shared(identifier: identifier).setEventsCompletionHandler(completionHandler)
        return true
        #else
        return false
        #endif
    }

    // MARK: - Internal

    static func configure(_ configuration: FixrConfiguration, transport: FixrTransport?, clock: FixrClock,
                          schedulesRetries: Bool) {
        let runtime = FixrRuntime.shared
        let uploader: Uploader = runtime.lock.locked {
            let settings = Uploader.Settings(endpoint: configuration.endpoint, projectKey: configuration.projectKey)
            let directory = configuration.queueDirectory ?? DiskQueue.defaultDirectory()
            runtime.configuration = configuration
            if let existing = runtime.uploader, transport == nil, existing.queue.directory == directory {
                existing.update(settings: settings)
                return existing
            }
            let made = Uploader(settings: settings, queue: DiskQueue(directory: directory),
                                transport: transport ?? runtime.transport ?? makeTransport(configuration),
                                clock: clock, schedulesRetries: schedulesRetries)
            if transport == nil { runtime.transport = made.transport }
            runtime.uploader = made
            return made
        }
        uploader.start()
        FixrPlatform.didConfigure(configuration)
    }

    static func submit(prompt: String, screenshot: FixrScreenshot?, omittedReason: String?,
                       extra: [String: String], context: Report.Context? = nil) throws -> String {
        let runtime = FixrRuntime.shared
        guard let configuration = runtime.configuration, let uploader = runtime.uploader else {
            throw FixrError.notConfigured
        }
        FixrPlatform.refreshSnapshotIfOnMain()
        let snapshot = PlatformSnapshot.shared
        let report = try ReportBuilder.make(
            prompt: prompt,
            extra: extra,
            metadata: configuration.metadataProvider?() ?? [:],
            screenshotOmittedReason: screenshot == nil ? omittedReason : nil,
            context: context ?? snapshot.context,
            screen: snapshot.screen,
            now: uploader.clock.now()
        )
        return try uploader.submit(report, screenshot: screenshot)
    }

    static func makeTransport(_ configuration: FixrConfiguration) -> FixrTransport {
        #if os(iOS) || os(macOS)
        // Background sessions need a bundled app; fall back for CLI tools and tests.
        if configuration.backgroundUploads, let bundleID = Bundle.main.bundleIdentifier {
            return BackgroundSessionTransport.shared(identifier: BackgroundSessionTransport.identifierPrefix + bundleID)
        }
        #endif
        return URLSessionTransport()
    }

    /// Tears down global state (tests).
    static func reset() {
        FixrRuntime.shared.lock.locked {
            FixrRuntime.shared.configuration = nil
            FixrRuntime.shared.uploader = nil
            FixrRuntime.shared.transport = nil
        }
    }
}

final class FixrRuntime: @unchecked Sendable {
    static let shared = FixrRuntime()
    /// Recursive so the accessors below can be used inside `lock.locked { }`.
    let lock = NSRecursiveLock()
    private var _configuration: FixrConfiguration?
    private var _uploader: Uploader?
    private var _transport: FixrTransport?

    var configuration: FixrConfiguration? {
        get { lock.locked { _configuration } }
        set { lock.locked { _configuration = newValue } }
    }

    var uploader: Uploader? {
        get { lock.locked { _uploader } }
        set { lock.locked { _uploader = newValue } }
    }

    var transport: FixrTransport? {
        get { lock.locked { _transport } }
        set { lock.locked { _transport = newValue } }
    }
}

#if os(watchOS) || (!canImport(UIKit) && !canImport(AppKit))
/// No UI layer on this platform (e.g. Linux): `present()` and triggers are no-ops.
enum FixrPlatform {
    static func didConfigure(_ configuration: FixrConfiguration) {}
    static func refreshSnapshotIfOnMain() {}
    @MainActor static func present(_ configuration: FixrConfiguration) {}
}
#endif
