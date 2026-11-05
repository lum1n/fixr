import Foundation
import XCTest
@testable import Fixr
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Real HTTP against spec/echo-server/server.mjs. Skipped when `node` is not
/// on PATH. Uses the plain URLSession transport (FoundationNetworking on Linux).
final class EchoServerIntegrationTests: XCTestCase {
    private var servers: [EchoServer] = []
    private var dirs: [URL] = []

    override func tearDown() {
        servers.forEach { $0.stop() }
        dirs.forEach { try? FileManager.default.removeItem(at: $0) }
        Fixr.reset()
    }

    private func startServer(_ args: [String] = []) throws -> EchoServer {
        guard let node = EchoServer.findNode() else { throw XCTSkip("node is not on PATH") }
        guard FileManager.default.fileExists(atPath: Paths.echoServer.path) else {
            throw XCTSkip("echo server not found at \(Paths.echoServer.path)")
        }
        let dir = Paths.tempDirectory(name)
        dirs.append(dir)
        let server = try EchoServer(node: node, directory: dir, extraArgs: args)
        servers.append(server)
        return server
    }

    private func makeUploader(_ server: EchoServer, key: String = "pk_dev",
                              log: OutcomeLog, expectation: XCTestExpectation) -> Uploader {
        let queueDir = server.directory.appendingPathComponent("queue")
        let uploader = Uploader(settings: .init(endpoint: server.baseURL, projectKey: key),
                                queue: DiskQueue(directory: queueDir), transport: URLSessionTransport(),
                                schedulesRetries: false)
        // The observer outlives the first wait and fires again for later outcomes.
        expectation.assertForOverFulfill = false
        uploader.addObserver { id, outcome in
            log.append(id, outcome)
            expectation.fulfill()
        }
        uploader.start()
        return uploader
    }

    func testDeliversMultipartWithScreenshotThenDuplicate() throws {
        let server = try startServer()
        let log = OutcomeLog()
        let first = expectation(description: "first delivery")
        let uploader = makeUploader(server, log: log, expectation: first)

        let report = Report.sample(prompt: "Make the Save button line up with Cancel")
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] + Array(repeating: UInt8(7), count: 64))
        try uploader.submit(report, screenshot: FixrScreenshot(data: png, mime: .png))
        wait(for: [first], timeout: 15)
        XCTAssertEqual(log.all.first?.1, .delivered(duplicate: false))
        XCTAssertEqual(uploader.queue.count, 0)

        let stored = try Data(contentsOf: server.outDirectory.appendingPathComponent("\(report.id).json"))
        XCTAssertEqual(try jsonObject(stored), try jsonObject(ReportEncoder.encode(report)))
        XCTAssertEqual(try Data(contentsOf: server.outDirectory.appendingPathComponent("\(report.id).png")), png)
        XCTAssertTrue(server.log().contains("fixr-swift/0.1.0"), server.log())

        // Same id again (e.g. a retry after a lost response) → 200 duplicate.
        let second = expectation(description: "duplicate")
        uploader.addObserver { _, _ in second.fulfill() }
        try uploader.submit(report, screenshot: nil)
        wait(for: [second], timeout: 15)
        XCTAssertEqual(log.all.last?.1, .delivered(duplicate: true))
    }

    func testServiceUnavailableIsRetriedThenDelivered() throws {
        let server = try startServer(["--fail-first", "1"])
        let log = OutcomeLog()
        let first = expectation(description: "503")
        let uploader = makeUploader(server, log: log, expectation: first)
        let id = try uploader.submit(.sample(), screenshot: nil)
        wait(for: [first], timeout: 15)
        XCTAssertEqual(log.all.first?.1, .retryLater(retryAfter: nil))
        XCTAssertEqual(uploader.queue.item(id: id)?.state.attempts, 1)

        let second = expectation(description: "delivered")
        uploader.addObserver { _, _ in second.fulfill() }
        uploader.drain(force: true)
        wait(for: [second], timeout: 15)
        XCTAssertEqual(log.all.last?.1, .delivered(duplicate: false))
        XCTAssertNil(uploader.queue.item(id: id))
    }

    func testWrongKeyIsDropped() throws {
        let server = try startServer(["--key", "right"])
        let log = OutcomeLog()
        let done = expectation(description: "401")
        let uploader = makeUploader(server, key: "wrong", log: log, expectation: done)
        try uploader.submit(.sample(), screenshot: nil)
        wait(for: [done], timeout: 15)
        XCTAssertEqual(log.all.first?.1, .dropped(status: 401))
        XCTAssertEqual(uploader.queue.count, 0)
    }

    func testPublicAPIEndToEnd() throws {
        let server = try startServer()
        let queueDir = server.directory.appendingPathComponent("queue")
        Fixr.configure(FixrConfiguration(endpoint: server.baseURL, projectKey: "pk_dev",
                                         metadataProvider: { ["source": "integration-test"] },
                                         backgroundUploads: false,
                                         queueDirectory: queueDir))
        let id = try Fixr.send(prompt: "Title should be bold",
                               image: FixrScreenshot(data: Data([0xFF, 0xD8, 0xFF, 0xD9]), mime: .jpeg),
                               extra: ["branch": "main"])
        let file = server.outDirectory.appendingPathComponent("\(id).json")
        let deadline = Date().addingTimeInterval(15)
        while !FileManager.default.fileExists(atPath: file.path) && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        let stored = try jsonObject(Data(contentsOf: file))
        XCTAssertEqual(stored["prompt"] as? String, "Title should be bold")
        XCTAssertEqual(stored["extra"] as? NSDictionary, ["branch": "main", "source": "integration-test"])
        XCTAssertEqual((stored["sdk"] as? NSDictionary)?["name"] as? String, "fixr-swift")
        XCTAssertTrue(FileManager.default.fileExists(atPath: server.outDirectory.appendingPathComponent("\(id).jpg").path))
    }
}

/// Runs `node spec/echo-server/server.mjs` on a free port.
final class EchoServer {
    let process = Process()
    let directory: URL
    let outDirectory: URL
    let logFile: URL
    let port: Int

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    init(node: URL, directory: URL, extraArgs: [String]) throws {
        self.directory = directory
        outDirectory = directory.appendingPathComponent("out")
        logFile = directory.appendingPathComponent("server.log")
        _ = FileManager.default.createFile(atPath: logFile.path, contents: nil)
        port = Self.freePort()
        process.executableURL = node
        process.arguments = [Paths.echoServer.path, "--port", String(port), "--out", outDirectory.path] + extraArgs
        let handle = try FileHandle(forWritingTo: logFile)
        process.standardOutput = handle
        process.standardError = handle
        try process.run()

        let deadline = Date().addingTimeInterval(10)
        while !log().contains("fixr echo server on") {
            guard process.isRunning, Date() < deadline else {
                stop()
                throw XCTSkip("echo server did not start: \(log())")
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    func log() -> String {
        (try? String(contentsOf: logFile, encoding: .utf8)) ?? ""
    }

    func stop() {
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
    }

    static func findNode() -> URL? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"
        for dir in path.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent("node")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// Random high port; collisions are unlikely and surface as a skip.
    static func freePort() -> Int { Int.random(in: 20_000...45_000) }
}
