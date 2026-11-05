import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Uploads a prepared request body from a file and reports the outcome per
/// report id. Event-based rather than callback-per-call because a background
/// `URLSession` delivers results for tasks started by a previous process.
public protocol FixrTransport: AnyObject, Sendable {
    /// Called on an arbitrary queue when an upload finishes.
    var onOutcome: (@Sendable (_ reportID: String, _ outcome: DeliveryOutcome) -> Void)? { get set }
    func upload(reportID: String, request: URLRequest, bodyFile: URL)
    /// Report ids with an upload still in flight (e.g. a background task that
    /// survived a relaunch), so they are not started twice.
    func inFlightReportIDs(_ completion: @escaping @Sendable (Set<String>) -> Void)
}

/// Plain foreground `URLSession` upload. Used on Linux (FoundationNetworking),
/// in tests, and on Apple platforms when background uploads are disabled or
/// unavailable (no bundle identifier).
public final class URLSessionTransport: FixrTransport, @unchecked Sendable {
    private let session: URLSession
    private let lock = NSLock()
    private var handler: (@Sendable (String, DeliveryOutcome) -> Void)?
    private var running: Set<String> = []

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.timeoutIntervalForRequest = 60
        session = URLSession(configuration: configuration)
    }

    public var onOutcome: (@Sendable (String, DeliveryOutcome) -> Void)? {
        get { lock.locked { handler } }
        set { lock.locked { handler = newValue } }
    }

    public func upload(reportID: String, request: URLRequest, bodyFile: URL) {
        lock.locked { _ = running.insert(reportID) }
        let completion: @Sendable (Data?, URLResponse?, Error?) -> Void = { [weak self] _, response, error in
            guard let self else { return }
            let outcome = ResponseClassifier.classify(response: response, error: error)
            let handler = self.lock.locked { () -> (@Sendable (String, DeliveryOutcome) -> Void)? in
                self.running.remove(reportID)
                return self.handler
            }
            handler?(reportID, outcome)
        }
        #if canImport(FoundationNetworking)
        // swift-corelibs-foundation: upload from memory; bodies are ≤ 2.5 MiB.
        guard let data = try? Data(contentsOf: bodyFile) else {
            completion(nil, nil, CocoaError(.fileReadNoSuchFile))
            return
        }
        session.uploadTask(with: request, from: data, completionHandler: completion).resume()
        #else
        session.uploadTask(with: request, fromFile: bodyFile, completionHandler: completion).resume()
        #endif
    }

    public func inFlightReportIDs(_ completion: @escaping @Sendable (Set<String>) -> Void) {
        completion(lock.locked { running })
    }
}
