import Foundation

/// Persistent outbox: `<directory>/<report id>/{report.json, screenshot.(png|jpg), state.json}`.
///
/// `report.json` holds the exact bytes sent as the `report` part, so every
/// retry sends the same document. Items are written into a hidden staging
/// directory and moved into place, so a crash never leaves a half item.
/// Thread-safe.
public final class DiskQueue: @unchecked Sendable {
    public struct State: Codable, Equatable, Sendable {
        public var attempts: Int
        /// Unix seconds.
        public var nextAttemptAt: Double
        /// Unix seconds; the report's `created_at`.
        public var createdAt: Double
        public var lastStatus: Int?

        enum CodingKeys: String, CodingKey {
            case attempts
            case nextAttemptAt = "next_attempt_at"
            case createdAt = "created_at"
            case lastStatus = "last_status"
        }
    }

    public struct Item: Equatable, Sendable {
        public let id: String
        public let reportJSON: Data
        public let screenshot: FixrScreenshot?
        public var state: State

        public var createdAt: Date { Date(timeIntervalSince1970: state.createdAt) }
        public var nextAttemptAt: Date { Date(timeIntervalSince1970: state.nextAttemptAt) }
    }

    public let directory: URL
    private let fileManager = FileManager.default
    private let lock = NSLock()

    static let reportFile = "report.json"
    static let stateFile = "state.json"
    static let bodyFile = "body.multipart"

    public init(directory: URL) {
        self.directory = directory
    }

    /// Default location: `Application Support/Fixr/queue` (on Linux, the XDG data dir).
    public static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Fixr", isDirectory: true).appendingPathComponent("queue", isDirectory: true)
    }

    public func enqueue(id: String, reportJSON: Data, screenshot: FixrScreenshot?, createdAt: Date, now: Date) throws {
        guard Self.isValidID(id) else { throw FixrError.queueWriteFailed("invalid id \(id)") }
        try lock.locked {
            try ensureDirectory()
            let final = itemDirectory(id)
            if fileManager.fileExists(atPath: final.path) { return }
            let staging = directory.appendingPathComponent(".staging-\(id)", isDirectory: true)
            try? fileManager.removeItem(at: staging)
            try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
            do {
                try reportJSON.write(to: staging.appendingPathComponent(Self.reportFile))
                if let screenshot {
                    try screenshot.data.write(to: staging.appendingPathComponent(screenshot.filename))
                }
                let state = State(attempts: 0, nextAttemptAt: now.timeIntervalSince1970,
                                  createdAt: createdAt.timeIntervalSince1970, lastStatus: nil)
                try Self.encodeState(state).write(to: staging.appendingPathComponent(Self.stateFile))
                try fileManager.moveItem(at: staging, to: final)
            } catch {
                try? fileManager.removeItem(at: staging)
                throw FixrError.queueWriteFailed(String(describing: error))
            }
        }
    }

    /// All complete items, oldest first.
    public func items() -> [Item] {
        lock.locked {
            guard let names = try? fileManager.contentsOfDirectory(atPath: directory.path) else { return [] }
            return names.filter(Self.isValidID).compactMap(loadItem)
                .sorted { ($0.state.createdAt, $0.id) < ($1.state.createdAt, $1.id) }
        }
    }

    public func item(id: String) -> Item? {
        guard Self.isValidID(id) else { return nil }
        return lock.locked { loadItem(id) }
    }

    public func updateState(id: String, _ state: State) throws {
        try lock.locked {
            let dir = itemDirectory(id)
            guard fileManager.fileExists(atPath: dir.path) else { return }
            try Self.encodeState(state).write(to: dir.appendingPathComponent(Self.stateFile), options: .atomic)
        }
    }

    public func remove(id: String) {
        guard Self.isValidID(id) else { return }
        lock.locked { _ = try? fileManager.removeItem(at: itemDirectory(id)) }
    }

    /// Writes the multipart body for `id` next to the item, for file uploads
    /// (background `URLSession` requires a file). Returns its URL.
    public func writeBody(id: String, _ body: MultipartBody) throws -> URL {
        try lock.locked {
            let url = itemDirectory(id).appendingPathComponent(Self.bodyFile)
            try body.data.write(to: url, options: .atomic)
            return url
        }
    }

    public var count: Int { items().count }

    // MARK: - Private

    func itemDirectory(_ id: String) -> URL { directory.appendingPathComponent(id, isDirectory: true) }

    private func ensureDirectory() throws {
        if !fileManager.fileExists(atPath: directory.path) {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            #if os(iOS)
            var url = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
            #endif
        }
    }

    private func loadItem(_ id: String) -> Item? {
        let dir = itemDirectory(id)
        guard let report = try? Data(contentsOf: dir.appendingPathComponent(Self.reportFile)),
              let stateData = try? Data(contentsOf: dir.appendingPathComponent(Self.stateFile)),
              let state = try? JSONDecoder().decode(State.self, from: stateData) else { return nil }
        var screenshot: FixrScreenshot?
        for mime in [FixrScreenshot.MIME.png, .jpeg] {
            let url = dir.appendingPathComponent("screenshot.\(mime.fileExtension)")
            if let data = try? Data(contentsOf: url) {
                screenshot = FixrScreenshot(data: data, mime: mime)
                break
            }
        }
        return Item(id: id, reportJSON: report, screenshot: screenshot, state: state)
    }

    private static func encodeState(_ state: State) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(state)
    }

    static func isValidID(_ id: String) -> Bool {
        let scalars = Array(id.unicodeScalars)
        guard scalars.count == 36 else { return false }
        for (i, c) in scalars.enumerated() {
            if [8, 13, 18, 23].contains(i) {
                if c != "-" { return false }
            } else if !(("0"..."9").contains(c) || ("a"..."f").contains(c)) {
                return false
            }
        }
        return true
    }
}

extension NSLocking {
    @discardableResult
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
