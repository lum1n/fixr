// Apple-only (not compiled on Linux).
#if os(iOS) || os(macOS)
import Foundation

/// Uploads with a background `URLSession` (`uploadTask(with:fromFile:)`) so a
/// report keeps uploading while the app is suspended or after it is killed.
/// One instance per session identifier per process, as URLSession requires.
/// Outcomes that arrive before the uploader attaches (a relaunch for
/// background events) are buffered.
final class BackgroundSessionTransport: NSObject, FixrTransport, URLSessionDataDelegate, @unchecked Sendable {
    static let identifierPrefix = "dev.fixr.upload."

    private static let registryLock = NSLock()
    private static var registry: [String: BackgroundSessionTransport] = [:]

    static func shared(identifier: String) -> BackgroundSessionTransport {
        registryLock.locked {
            if let existing = registry[identifier] { return existing }
            let made = BackgroundSessionTransport(identifier: identifier)
            registry[identifier] = made
            return made
        }
    }

    let identifier: String
    private let lock = NSLock()
    private var handler: (@Sendable (String, DeliveryOutcome) -> Void)?
    private var buffered: [(String, DeliveryOutcome)] = []
    private var eventsCompletionHandler: (() -> Void)?
    private var session: URLSession!

    private init(identifier: String) {
        self.identifier = identifier
        super.init()
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.isDiscretionary = false
        configuration.allowsCellularAccess = true
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        #if os(iOS)
        configuration.sessionSendsLaunchEvents = true
        #endif
        let delegateQueue = OperationQueue()
        delegateQueue.name = "dev.fixr.upload.delegate"
        delegateQueue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }

    var onOutcome: (@Sendable (String, DeliveryOutcome) -> Void)? {
        get { lock.locked { handler } }
        set {
            let pending: [(String, DeliveryOutcome)] = lock.locked {
                handler = newValue
                defer { buffered.removeAll() }
                return newValue == nil ? [] : buffered
            }
            for (id, outcome) in pending { newValue?(id, outcome) }
        }
    }

    func upload(reportID: String, request: URLRequest, bodyFile: URL) {
        let task = session.uploadTask(with: request, fromFile: bodyFile)
        task.taskDescription = reportID
        task.resume()
    }

    func inFlightReportIDs(_ completion: @escaping @Sendable (Set<String>) -> Void) {
        session.getAllTasks { tasks in
            let ids = tasks
                .filter { $0.state == .running || $0.state == .suspended }
                .compactMap(\.taskDescription)
            completion(Set(ids))
        }
    }

    /// Called on the main queue once the session has delivered all pending events.
    func setEventsCompletionHandler(_ handler: @escaping () -> Void) {
        lock.locked { eventsCompletionHandler = handler }
    }

    private func deliver(_ id: String, _ outcome: DeliveryOutcome) {
        let target: (@Sendable (String, DeliveryOutcome) -> Void)? = lock.locked {
            if handler == nil { buffered.append((id, outcome)) }
            return handler
        }
        target?(id, outcome)
    }

    // MARK: URLSessionDelegate

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        deliver(id, ResponseClassifier.classify(response: task.response, error: error))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        // Response bodies are not needed: the status code decides the outcome.
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion: (() -> Void)? = lock.locked {
            defer { eventsCompletionHandler = nil }
            return eventsCompletionHandler
        }
        if let completion { DispatchQueue.main.async { completion() } }
    }
}
#endif
