import Foundation
import XCTest
@testable import Fixr

final class DiskQueueTests: XCTestCase {
    func testEnqueueLayoutAndRoundTrip() throws {
        let dir = Paths.tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let queue = DiskQueue(directory: dir)
        let report = Report.sample()
        let json = try ReportEncoder.encode(report)
        let shot = FixrScreenshot(data: Data([1, 2, 3]), mime: .jpeg)
        let created = Date(timeIntervalSince1970: 1_793_887_392)
        try queue.enqueue(id: report.id, reportJSON: json, screenshot: shot, createdAt: created, now: created)

        let itemDir = dir.appendingPathComponent(report.id)
        let files = try FileManager.default.contentsOfDirectory(atPath: itemDir.path).sorted()
        XCTAssertEqual(files, ["report.json", "screenshot.jpg", "state.json"])

        let item = try XCTUnwrap(queue.item(id: report.id))
        XCTAssertEqual(item.reportJSON, json)
        XCTAssertEqual(item.screenshot, shot)
        XCTAssertEqual(item.state, .init(attempts: 0, nextAttemptAt: created.timeIntervalSince1970,
                                         createdAt: created.timeIntervalSince1970, lastStatus: nil))
        let state = try jsonObject(Data(contentsOf: itemDir.appendingPathComponent("state.json")))
        XCTAssertEqual(state["attempts"] as? Int, 0)
        XCTAssertNotNil(state["next_attempt_at"])

        var updated = item.state
        updated.attempts = 3
        try queue.updateState(id: report.id, updated)
        XCTAssertEqual(queue.item(id: report.id)?.state.attempts, 3)

        // A second queue over the same directory sees the item (persistence).
        XCTAssertEqual(DiskQueue(directory: dir).items().map(\.id), [report.id])

        queue.remove(id: report.id)
        XCTAssertEqual(queue.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: itemDir.path))
    }

    func testOrderingAndIgnoringJunk() throws {
        let dir = Paths.tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let queue = DiskQueue(directory: dir)
        let older = Report.sample(), newer = Report.sample()
        try queue.enqueue(id: newer.id, reportJSON: Data("{}".utf8), screenshot: nil,
                          createdAt: Date(timeIntervalSince1970: 200), now: Date())
        try queue.enqueue(id: older.id, reportJSON: Data("{}".utf8), screenshot: nil,
                          createdAt: Date(timeIntervalSince1970: 100), now: Date())
        // Half-written staging dir, a non-id dir, and an id dir without state.json.
        let fm = FileManager.default
        try fm.createDirectory(at: dir.appendingPathComponent(".staging-\(Report.makeID())"), withIntermediateDirectories: true)
        try fm.createDirectory(at: dir.appendingPathComponent("not-an-id"), withIntermediateDirectories: true)
        let partial = dir.appendingPathComponent(Report.makeID())
        try fm.createDirectory(at: partial, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: partial.appendingPathComponent("report.json"))

        XCTAssertEqual(queue.items().map(\.id), [older.id, newer.id])
        XCTAssertThrowsError(try queue.enqueue(id: "../escape", reportJSON: Data(), screenshot: nil,
                                               createdAt: Date(), now: Date()))
    }

    func testEnqueueIsIdempotentPerID() throws {
        let dir = Paths.tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let queue = DiskQueue(directory: dir)
        let id = Report.makeID()
        try queue.enqueue(id: id, reportJSON: Data("1".utf8), screenshot: nil, createdAt: Date(), now: Date())
        try queue.enqueue(id: id, reportJSON: Data("2".utf8), screenshot: nil, createdAt: Date(), now: Date())
        XCTAssertEqual(queue.items().map(\.reportJSON), [Data("1".utf8)])
    }
}
