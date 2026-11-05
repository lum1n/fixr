import Foundation
import XCTest
@testable import Fixr
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum Paths {
    /// clients/swift/Tests/FixrTests/Support.swift → repository root.
    static let repoRoot: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url
    }()

    static var fixture: URL { repoRoot.appendingPathComponent("spec/fixtures/report.v1.json") }
    static var echoServer: URL { repoRoot.appendingPathComponent("spec/echo-server/server.mjs") }

    static func tempDirectory(_ name: String = #function) -> URL {
        let safe = name.filter { $0.isLetter || $0.isNumber }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("fixr-tests-\(safe)-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

final class FakeClock: FixrClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date = Date(timeIntervalSince1970: 1_793_890_000)) { current = start }

    func now() -> Date { lock.lock(); defer { lock.unlock() }; return current }

    func advance(_ seconds: TimeInterval) {
        lock.lock(); current = current.addingTimeInterval(seconds); lock.unlock()
    }
}

final class FakeTransport: FixrTransport, @unchecked Sendable {
    struct Upload {
        let reportID: String
        let request: URLRequest
        let body: Data
    }

    private let lock = NSLock()
    private var _uploads: [Upload] = []
    private var handler: (@Sendable (String, DeliveryOutcome) -> Void)?
    var preexistingInFlight: Set<String> = []

    var onOutcome: (@Sendable (String, DeliveryOutcome) -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return handler }
        set { lock.lock(); handler = newValue; lock.unlock() }
    }

    var uploads: [Upload] { lock.lock(); defer { lock.unlock() }; return _uploads }

    func upload(reportID: String, request: URLRequest, bodyFile: URL) {
        let body = (try? Data(contentsOf: bodyFile)) ?? Data()
        lock.lock(); _uploads.append(Upload(reportID: reportID, request: request, body: body)); lock.unlock()
    }

    func inFlightReportIDs(_ completion: @escaping @Sendable (Set<String>) -> Void) {
        completion(preexistingInFlight)
    }

    func complete(_ id: String, _ outcome: DeliveryOutcome) {
        onOutcome?(id, outcome)
    }
}

extension Report {
    static func sample(id: String = Report.makeID(), createdAt: String = "2026-11-05T14:03:12Z",
                       prompt: String = "Fix the button") -> Report {
        Report(id: id, createdAt: createdAt, prompt: prompt,
               sdk: .init(name: "fixr-swift", version: "0.1.0"),
               app: .init(id: "com.example.tests"),
               device: .init(platform: "linux"))
    }
}

/// Minimal multipart parser for assertions (mirrors the echo server's).
func parseMultipart(_ data: Data, boundary: String) -> [(headers: String, body: Data)] {
    let delimiter = Data("--\(boundary)".utf8)
    var parts: [(String, Data)] = []
    guard var pos = data.range(of: delimiter)?.upperBound else { return [] }
    while true {
        if data[pos..<min(pos + 2, data.endIndex)] == Data("--".utf8) { break }
        pos += 2
        guard let headEnd = data.range(of: Data("\r\n\r\n".utf8), in: pos..<data.endIndex),
              let next = data.range(of: delimiter, in: headEnd.upperBound..<data.endIndex) else { break }
        let headers = String(decoding: data[pos..<headEnd.lowerBound], as: UTF8.self)
        parts.append((headers, Data(data[headEnd.upperBound..<(next.lowerBound - 2)])))
        pos = next.upperBound
    }
    return parts
}

func jsonObject(_ data: Data) throws -> NSDictionary {
    try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
}
