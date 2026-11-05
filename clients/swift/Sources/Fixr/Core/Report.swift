import Foundation

/// The report document (`schema: 1`) sent as the `report` part of
/// `POST /v1/reports`. See `spec/wire-format.md`.
///
/// Optional members are omitted from the JSON when `nil`, never encoded as `null`.
public struct Report: Codable, Equatable, Sendable {
    public var schema: Int
    public var id: String
    public var createdAt: String
    public var prompt: String
    public var sdk: SDK
    public var app: App
    public var device: Device
    public var locale: String?
    public var context: Context?
    public var screenshotOmittedReason: String?
    public var extra: [String: String]?

    public init(
        id: String,
        createdAt: String,
        prompt: String,
        sdk: SDK,
        app: App,
        device: Device,
        locale: String? = nil,
        context: Context? = nil,
        screenshotOmittedReason: String? = nil,
        extra: [String: String]? = nil
    ) {
        self.schema = 1
        self.id = id
        self.createdAt = createdAt
        self.prompt = prompt
        self.sdk = sdk
        self.app = app
        self.device = device
        self.locale = locale
        self.context = context
        self.screenshotOmittedReason = screenshotOmittedReason
        self.extra = extra
    }

    enum CodingKeys: String, CodingKey {
        case schema, id
        case createdAt = "created_at"
        case prompt, sdk, app, device, locale, context
        case screenshotOmittedReason = "screenshot_omitted_reason"
        case extra
    }

    public struct SDK: Codable, Equatable, Sendable {
        public var name: String
        public var version: String
        public init(name: String, version: String) {
            self.name = name
            self.version = version
        }
    }

    public struct App: Codable, Equatable, Sendable {
        public var id: String
        public var version: String?
        public var build: String?
        public init(id: String, version: String? = nil, build: String? = nil) {
            self.id = id
            self.version = version
            self.build = build
        }
    }

    public struct Device: Codable, Equatable, Sendable {
        public var platform: String
        public var osVersion: String?
        public var model: String?
        public var screen: Screen?
        public init(platform: String, osVersion: String? = nil, model: String? = nil, screen: Screen? = nil) {
            self.platform = platform
            self.osVersion = osVersion
            self.model = model
            self.screen = screen
        }

        enum CodingKeys: String, CodingKey {
            case platform
            case osVersion = "os_version"
            case model, screen
        }
    }

    /// Screen bounds in points; `scale` is the pixel ratio.
    public struct Screen: Codable, Equatable, Sendable {
        public var width: Int
        public var height: Int
        public var scale: Double
        public init(width: Int, height: Int, scale: Double) {
            self.width = width
            self.height = height
            self.scale = scale
        }
    }

    public struct Context: Codable, Equatable, Sendable {
        public var screen: String?
        public var title: String?
        public var url: String?
        public init(screen: String? = nil, title: String? = nil, url: String? = nil) {
            self.screen = screen
            self.title = title
            self.url = url
        }

        var isEmpty: Bool { screen == nil && title == nil && url == nil }
    }
}

/// Wire-format limits, identical on all clients (spec/wire-format.md, "Limits").
public enum FixrLimits {
    public static let promptMaxScalars = 4000
    public static let imageMaxDimension = 2000
    public static let imageMaxBytes = 2_000_000
    public static let requestMaxBytes = 2_621_440
    public static let imageMinDimension = 200
    public static let extraMaxKeys = 32
    public static let extraMaxKeyLength = 64
    public static let extraMaxValueLength = 1000
}

/// Reasons for `screenshot_omitted_reason`.
public enum ScreenshotOmittedReason {
    public static let userRemoved = "user_removed"
    public static let captureFailed = "capture_failed"
    public static let captureDisabled = "capture_disabled"
    public static let tooLarge = "too_large"
}

public enum FixrError: Error, Equatable, Sendable {
    case notConfigured
    case emptyPrompt
    case promptTooLong(scalars: Int)
    case queueWriteFailed(String)
}

extension Report {
    /// Validates the prompt per the wire format: 1–4000 Unicode scalar values,
    /// not only whitespace.
    static func validatePrompt(_ prompt: String) throws {
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw FixrError.emptyPrompt }
        let count = prompt.unicodeScalars.count
        if count > FixrLimits.promptMaxScalars { throw FixrError.promptTooLong(scalars: count) }
    }

    /// Clamps `extra` to the wire limits: keys longer than 64 characters are
    /// dropped, values are truncated to 1000 characters, and at most 32 keys
    /// are kept (in sorted order, so the choice is deterministic).
    static func sanitizeExtra(_ extra: [String: String]) -> [String: String]? {
        var out: [String: String] = [:]
        for key in extra.keys.sorted() {
            guard out.count < FixrLimits.extraMaxKeys else { break }
            guard !key.isEmpty, key.count <= FixrLimits.extraMaxKeyLength, let value = extra[key] else { continue }
            out[key] = value.count > FixrLimits.extraMaxValueLength
                ? String(value.prefix(FixrLimits.extraMaxValueLength)) : value
        }
        return out.isEmpty ? nil : out
    }

    /// A lowercase UUID v4 (Foundation's `UUID()` is random, version 4).
    static func makeID() -> String { UUID().uuidString.lowercased() }

    /// `YYYY-MM-DDTHH:MM:SSZ`, UTC, whole seconds.
    static func timestamp(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        func pad(_ v: Int?, _ width: Int = 2) -> String {
            let s = String(v ?? 0)
            return String(repeating: "0", count: max(0, width - s.count)) + s
        }
        return "\(pad(c.year, 4))-\(pad(c.month))-\(pad(c.day))T\(pad(c.hour)):\(pad(c.minute)):\(pad(c.second))Z"
    }
}

/// Deterministic JSON for the report document: sorted keys, no escaped
/// slashes, optionals omitted.
public enum ReportEncoder {
    public static func encode(_ report: Report) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(report)
    }

    public static func decode(_ data: Data) throws -> Report {
        try JSONDecoder().decode(Report.self, from: data)
    }
}
