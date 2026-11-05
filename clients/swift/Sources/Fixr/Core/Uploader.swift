import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Drains the disk queue through a transport, applying the response table and
/// retry schedule. All state changes happen on one serial queue.
public final class Uploader: @unchecked Sendable {
    public struct Settings: Equatable, Sendable {
        public var endpoint: URL
        public var projectKey: String
        public var userAgent: String

        public init(endpoint: URL, projectKey: String, userAgent: String = Fixr.userAgent) {
            self.endpoint = endpoint
            self.projectKey = projectKey
            self.userAgent = userAgent
        }

        /// `<endpoint>/v1/reports`, unless the endpoint already points there.
        public var reportsURL: URL {
            let path = endpoint.path
            if path.hasSuffix("/v1/reports") || path.hasSuffix("/v1/reports/") { return endpoint }
            return endpoint.appendingPathComponent("v1").appendingPathComponent("reports")
        }
    }

    public let queue: DiskQueue
    public let transport: FixrTransport
    public let clock: FixrClock
    public let policy: RetryPolicy
    /// Re-drain automatically when the earliest retry comes due (in-process
    /// timer; on iOS a suspended app drains again on foreground instead).
    public let schedulesRetries: Bool

    private let work = DispatchQueue(label: "dev.fixr.uploader")
    private var settings: Settings
    private var inFlight: Set<String> = []
    private var timer: DispatchWorkItem?
    /// False until `start()` has learned which uploads are already in flight;
    /// drains requested before then are deferred.
    private var started = false
    private var deferredForce: Bool?
    private var observers: [@Sendable (String, DeliveryOutcome) -> Void] = []

    public init(settings: Settings, queue: DiskQueue, transport: FixrTransport,
                clock: FixrClock = SystemClock(), policy: RetryPolicy = RetryPolicy(),
                schedulesRetries: Bool = true) {
        self.settings = settings
        self.queue = queue
        self.transport = transport
        self.clock = clock
        self.policy = policy
        self.schedulesRetries = schedulesRetries
        transport.onOutcome = { [weak self] id, outcome in self?.handle(id: id, outcome: outcome) }
    }

    /// Picks up uploads still running from a previous launch, then drains.
    /// Nothing is uploaded before this is called.
    public func start() {
        transport.inFlightReportIDs { [weak self] ids in
            guard let self else { return }
            self.work.async {
                self.inFlight.formUnion(ids)
                self.started = true
                let force = self.deferredForce ?? false
                self.deferredForce = nil
                self.drainLocked(force: force)
            }
        }
    }

    public func update(settings: Settings) {
        work.async { self.settings = settings }
    }

    /// Observe outcomes (tests, host logging). Called on the uploader queue.
    public func addObserver(_ observer: @escaping @Sendable (String, DeliveryOutcome) -> Void) {
        work.async { self.observers.append(observer) }
    }

    /// Writes the report to the queue (the durable step) and starts an upload.
    /// If the multipart body would exceed the request limit, the screenshot is
    /// dropped and `screenshot_omitted_reason` becomes `too_large`.
    @discardableResult
    public func submit(_ report: Report, screenshot: FixrScreenshot?) throws -> String {
        var report = report
        var screenshot = screenshot
        var json = try ReportEncoder.encode(report)
        if let shot = screenshot,
           MultipartBody.build(reportJSON: json, screenshot: shot).data.count > FixrLimits.requestMaxBytes
            || shot.data.count > FixrLimits.imageMaxBytes {
            screenshot = nil
            report.screenshotOmittedReason = ScreenshotOmittedReason.tooLarge
            json = try ReportEncoder.encode(report)
        }
        let createdAt = Self.parseTimestamp(report.createdAt) ?? clock.now()
        try queue.enqueue(id: report.id, reportJSON: json, screenshot: screenshot, createdAt: createdAt, now: clock.now())
        drain()
        return report.id
    }

    /// Starts uploads for every item that is due. `force` ignores backoff
    /// (but not the attempt/age limits).
    public func drain(force: Bool = false) {
        work.async { self.drainLocked(force: force) }
    }

    /// Blocks until queued work on the uploader queue has run (tests).
    public func sync() { work.sync {} }

    // MARK: - Private (on `work`)

    private func drainLocked(force: Bool) {
        guard started else {
            deferredForce = (deferredForce ?? false) || force
            return
        }
        let now = clock.now()
        let current = settings
        for item in queue.items() where !inFlight.contains(item.id) {
            if policy.isExhausted(attempts: item.state.attempts, createdAt: item.createdAt, now: now) {
                queue.remove(id: item.id)
                notify(item.id, .dropped(status: nil))
                continue
            }
            if !force && item.nextAttemptAt > now { continue }
            let body = MultipartBody.build(reportJSON: item.reportJSON, screenshot: item.screenshot)
            guard let file = try? queue.writeBody(id: item.id, body) else { continue }
            var request = URLRequest(url: current.reportsURL)
            request.httpMethod = "POST"
            request.setValue("Bearer \(current.projectKey)", forHTTPHeaderField: "Authorization")
            request.setValue(item.id, forHTTPHeaderField: "Idempotency-Key")
            request.setValue(current.userAgent, forHTTPHeaderField: "User-Agent")
            request.setValue(body.contentType, forHTTPHeaderField: "Content-Type")
            inFlight.insert(item.id)
            transport.upload(reportID: item.id, request: request, bodyFile: file)
        }
        scheduleTimer()
    }

    private func handle(id: String, outcome: DeliveryOutcome) {
        work.async {
            self.inFlight.remove(id)
            switch outcome {
            case .delivered, .dropped:
                self.queue.remove(id: id)
                self.notify(id, outcome)
            case .retryLater(let retryAfter):
                guard var item = self.queue.item(id: id) else { break }
                let now = self.clock.now()
                item.state.attempts += 1
                if self.policy.isExhausted(attempts: item.state.attempts, createdAt: item.createdAt, now: now) {
                    self.queue.remove(id: id)
                    self.notify(id, .dropped(status: nil))
                    break
                }
                let delay = self.policy.delay(afterFailedAttempt: item.state.attempts, retryAfter: retryAfter)
                item.state.nextAttemptAt = now.addingTimeInterval(delay).timeIntervalSince1970
                try? self.queue.updateState(id: id, item.state)
                self.notify(id, outcome)
            }
            self.drainLocked(force: false)
        }
    }

    private func notify(_ id: String, _ outcome: DeliveryOutcome) {
        for observer in observers { observer(id, outcome) }
    }

    private func scheduleTimer() {
        timer?.cancel()
        timer = nil
        guard schedulesRetries else { return }
        let pending = queue.items().filter { !inFlight.contains($0.id) }
        guard let next = pending.map(\.nextAttemptAt).min() else { return }
        let delay = max(1, next.timeIntervalSince(clock.now()))
        let item = DispatchWorkItem { [weak self] in self?.drainLocked(force: false) }
        timer = item
        work.asyncAfter(deadline: .now() + delay, execute: item)
    }

    static func parseTimestamp(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        return f.date(from: s)
    }
}
