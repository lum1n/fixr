import Foundation
import XCTest
@testable import Fixr
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class UploaderTests: XCTestCase {
    private var dir: URL!
    private var clock: FakeClock!
    private var transport: FakeTransport!
    private var uploader: Uploader!
    private let outcomes = OutcomeLog()

    override func setUp() {
        dir = Paths.tempDirectory(name)
        clock = FakeClock(Date(timeIntervalSince1970: 1_793_887_392))
        transport = FakeTransport()
        uploader = makeUploader()
        uploader.start()
        uploader.sync()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
    }

    private func makeUploader() -> Uploader {
        let u = Uploader(settings: .init(endpoint: URL(string: "https://fixr.example.workers.dev")!, projectKey: "pk_test"),
                         queue: DiskQueue(directory: dir), transport: transport, clock: clock, schedulesRetries: false)
        u.addObserver { [outcomes] id, outcome in outcomes.append(id, outcome) }
        return u
    }

    @discardableResult
    private func submit(_ report: Report = .sample(), screenshot: FixrScreenshot? = nil) throws -> String {
        let id = try uploader.submit(report, screenshot: screenshot)
        uploader.sync()
        return id
    }

    private func complete(_ id: String, _ outcome: DeliveryOutcome) {
        transport.complete(id, outcome)
        uploader.sync()
    }

    func testRequestHeadersAndBody() throws {
        let report = Report.sample()
        let shot = FixrScreenshot(data: Data([9, 9, 9]), mime: .png)
        try submit(report, screenshot: shot)
        let upload = try XCTUnwrap(transport.uploads.first)
        XCTAssertEqual(upload.request.url?.absoluteString, "https://fixr.example.workers.dev/v1/reports")
        XCTAssertEqual(upload.request.httpMethod, "POST")
        XCTAssertEqual(upload.request.value(forHTTPHeaderField: "Authorization"), "Bearer pk_test")
        XCTAssertEqual(upload.request.value(forHTTPHeaderField: "Idempotency-Key"), report.id)
        XCTAssertEqual(upload.request.value(forHTTPHeaderField: "User-Agent"), "fixr-swift/0.1.0")
        let contentType = try XCTUnwrap(upload.request.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertTrue(contentType.hasPrefix("multipart/form-data; boundary="))
        let boundary = String(contentType.dropFirst("multipart/form-data; boundary=".count))
        let parts = parseMultipart(upload.body, boundary: boundary)
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(try ReportEncoder.decode(parts[0].body), report)
        XCTAssertEqual(parts[1].body, shot.data)
    }

    func testEndpointAlreadyPointingAtReports() {
        let s = Uploader.Settings(endpoint: URL(string: "http://localhost:8787/v1/reports")!, projectKey: "k")
        XCTAssertEqual(s.reportsURL.absoluteString, "http://localhost:8787/v1/reports")
        let base = Uploader.Settings(endpoint: URL(string: "http://localhost:8787/")!, projectKey: "k")
        XCTAssertEqual(base.reportsURL.absoluteString, "http://localhost:8787/v1/reports")
    }

    func testDeliveredAndDuplicateRemoveFromQueue() throws {
        let a = try submit(), b = try submit()
        complete(a, .delivered(duplicate: false))
        complete(b, .delivered(duplicate: true))
        XCTAssertEqual(uploader.queue.count, 0)
        XCTAssertEqual(outcomes.all.map(\.1), [.delivered(duplicate: false), .delivered(duplicate: true)])
    }

    func testPermanentFailureDrops() throws {
        let id = try submit()
        complete(id, .dropped(status: 422))
        XCTAssertEqual(uploader.queue.count, 0)
        XCTAssertEqual(outcomes.all.last?.1, .dropped(status: 422))
    }

    func testRetryFollowsScheduleWithFakeClock() throws {
        let id = try submit()
        XCTAssertEqual(transport.uploads.count, 1)

        complete(id, .retryLater(retryAfter: nil))
        var item = try XCTUnwrap(uploader.queue.item(id: id))
        XCTAssertEqual(item.state.attempts, 1)
        XCTAssertEqual(item.nextAttemptAt, clock.now().addingTimeInterval(30))

        // Not due yet: draining does nothing.
        clock.advance(29)
        uploader.drain(); uploader.sync()
        XCTAssertEqual(transport.uploads.count, 1)

        clock.advance(1)
        uploader.drain(); uploader.sync()
        XCTAssertEqual(transport.uploads.count, 2)
        XCTAssertEqual(transport.uploads[1].request.value(forHTTPHeaderField: "Idempotency-Key"), id)
        XCTAssertEqual(transport.uploads[1].body.count, transport.uploads[0].body.count)

        complete(id, .retryLater(retryAfter: nil))
        item = try XCTUnwrap(uploader.queue.item(id: id))
        XCTAssertEqual(item.state.attempts, 2)
        XCTAssertEqual(item.nextAttemptAt, clock.now().addingTimeInterval(120))

        // A longer Retry-After overrides the table.
        clock.advance(120)
        uploader.drain(); uploader.sync()
        complete(id, .retryLater(retryAfter: 5000))
        item = try XCTUnwrap(uploader.queue.item(id: id))
        XCTAssertEqual(item.state.attempts, 3)
        XCTAssertEqual(item.nextAttemptAt, clock.now().addingTimeInterval(5000))
    }

    func testFlushIgnoresBackoff() throws {
        let id = try submit()
        complete(id, .retryLater(retryAfter: nil))
        XCTAssertEqual(transport.uploads.count, 1)
        uploader.drain(force: true); uploader.sync()
        XCTAssertEqual(transport.uploads.count, 2)
    }

    func testInFlightItemsAreNotStartedTwice() throws {
        _ = try submit()
        uploader.drain(force: true); uploader.sync()
        uploader.drain(force: true); uploader.sync()
        XCTAssertEqual(transport.uploads.count, 1)
    }

    func testDroppedAfterTwentyAttempts() throws {
        let id = try submit()
        for attempt in 1...20 {
            XCTAssertEqual(transport.uploads.count, attempt)
            complete(id, .retryLater(retryAfter: nil))
            uploader.drain(force: true); uploader.sync()
        }
        XCTAssertNil(uploader.queue.item(id: id))
        XCTAssertEqual(transport.uploads.count, 20)
        XCTAssertEqual(outcomes.all.last?.1, .dropped(status: nil))
    }

    func testDroppedSevenDaysAfterCreatedAt() throws {
        let id = try submit(.sample(createdAt: Report.timestamp(clock.now())))
        complete(id, .retryLater(retryAfter: nil))
        clock.advance(7 * 86_400)
        uploader.drain(force: true); uploader.sync()
        XCTAssertNil(uploader.queue.item(id: id))
        XCTAssertEqual(transport.uploads.count, 1)
        XCTAssertEqual(outcomes.all.last?.1, .dropped(status: nil))
    }

    func testOversizedScreenshotIsOmittedAsTooLarge() throws {
        let big = FixrScreenshot(data: Data(count: FixrLimits.imageMaxBytes + 1), mime: .jpeg)
        let id = try submit(screenshot: big)
        let item = try XCTUnwrap(uploader.queue.item(id: id))
        XCTAssertNil(item.screenshot)
        XCTAssertEqual(try ReportEncoder.decode(item.reportJSON).screenshotOmittedReason, "too_large")
    }

    func testQueueSurvivesRestartAndSkipsTasksStillInFlight() throws {
        let id = try submit()
        XCTAssertEqual(transport.uploads.count, 1)

        // "Relaunch": a new uploader over the same directory, with the
        // background session reporting the upload as still running.
        transport = FakeTransport()
        transport.preexistingInFlight = [id]
        uploader = makeUploader()
        uploader.drain(force: true) // before start(): deferred
        uploader.sync()
        XCTAssertEqual(transport.uploads.count, 0)
        uploader.start(); uploader.sync()
        XCTAssertEqual(transport.uploads.count, 0)

        // Its outcome arrives through the transport and is applied.
        complete(id, .delivered(duplicate: false))
        XCTAssertEqual(uploader.queue.count, 0)
    }

    func testRelaunchResendsQueuedItems() throws {
        let id = try submit()
        transport = FakeTransport()
        uploader = makeUploader()
        uploader.start(); uploader.sync()
        XCTAssertEqual(transport.uploads.map(\.reportID), [id])
    }
}

final class OutcomeLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(String, DeliveryOutcome)] = []

    func append(_ id: String, _ outcome: DeliveryOutcome) {
        lock.lock(); entries.append((id, outcome)); lock.unlock()
    }

    var all: [(String, DeliveryOutcome)] { lock.lock(); defer { lock.unlock() }; return entries }
}

final class FixrFacadeTests: XCTestCase {
    override func tearDown() { Fixr.reset() }

    func testSendRequiresConfiguration() {
        Fixr.reset()
        XCTAssertThrowsError(try Fixr.send(prompt: "x")) { XCTAssertEqual($0 as? FixrError, .notConfigured) }
    }

    func testSendQueuesAndUploadsWithMetadata() throws {
        let dir = Paths.tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let transport = FakeTransport()
        let config = FixrConfiguration(endpoint: URL(string: "http://localhost:1")!, projectKey: "pk",
                                       metadataProvider: { ["build_flavor": "debug", "branch": "meta"] },
                                       queueDirectory: dir)
        Fixr.configure(config, transport: transport, clock: FakeClock(), schedulesRetries: false)
        XCTAssertTrue(Fixr.isConfigured)
        XCTAssertThrowsError(try Fixr.send(prompt: "   ")) { XCTAssertEqual($0 as? FixrError, .emptyPrompt) }

        let id = try Fixr.send(prompt: "Make the title bold", extra: ["branch": "main"])
        FixrRuntime.shared.uploader?.sync()
        let upload = try XCTUnwrap(transport.uploads.first)
        XCTAssertEqual(upload.reportID, id)
        let boundary = String(upload.request.value(forHTTPHeaderField: "Content-Type")!
            .dropFirst("multipart/form-data; boundary=".count))
        let report = try ReportEncoder.decode(parseMultipart(upload.body, boundary: boundary)[0].body)
        XCTAssertEqual(report.prompt, "Make the title bold")
        XCTAssertEqual(report.extra, ["branch": "main", "build_flavor": "debug"])
        XCTAssertEqual(report.sdk.name, "fixr-swift")
        XCTAssertNil(report.screenshotOmittedReason)
        XCTAssertFalse(Fixr.handleEventsForBackgroundURLSession(identifier: "other.session") {})
    }
}
