import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

/// Host metadata that does not need UI frameworks. Screen and view context are
/// filled in by the platform layer (see `PlatformSnapshot`).
enum HostMetadata {
    static var platform: String {
        #if targetEnvironment(macCatalyst)
        return "macos"
        #elseif os(iOS) || os(tvOS) || os(visionOS)
        return "ios"
        #elseif os(macOS)
        return "macos"
        #elseif os(Windows)
        return "windows"
        #else
        return "linux"
        #endif
    }

    static func app(bundle: Bundle = .main) -> Report.App {
        let info = bundle.infoDictionary ?? [:]
        let id = bundle.bundleIdentifier ?? ProcessInfo.processInfo.processName
        return Report.App(
            id: id.isEmpty ? "unknown" : String(id.prefix(200)),
            version: (info["CFBundleShortVersionString"] as? String).map { String($0.prefix(64)) },
            build: (info["CFBundleVersion"] as? String).map { String($0.prefix(64)) }
        )
    }

    static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return v.patchVersion > 0 ? "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
            : "\(v.majorVersion).\(v.minorVersion)"
    }

    /// `hw.model` on macOS (e.g. `Mac15,6`), `utsname.machine` elsewhere
    /// (e.g. `iPhone16,1`; the simulator reports the simulated model).
    static var model: String? {
        #if os(macOS)
        var size = 0
        if sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 {
            var buffer = [CChar](repeating: 0, count: size)
            if sysctlbyname("hw.model", &buffer, &size, nil, 0) == 0 {
                return String(cString: buffer)
            }
        }
        return machine
        #else
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        return machine
        #endif
    }

    static var machine: String? {
        var info = utsname()
        guard uname(&info) == 0 else { return nil }
        let value = withUnsafeBytes(of: &info.machine) { raw -> String in
            let bytes = raw.prefix { $0 != 0 }
            return String(decoding: bytes, as: UTF8.self)
        }
        return value.isEmpty ? nil : value
    }

    /// BCP 47-ish tag, `en-US`, or nil for the POSIX locale.
    static var locale: String? {
        var id = Locale.current.identifier
        if let at = id.firstIndex(of: "@") { id = String(id[..<at]) }
        if let dot = id.firstIndex(of: ".") { id = String(id[..<dot]) }
        id = id.replacingOccurrences(of: "_", with: "-")
        if id.isEmpty || id == "POSIX" || id == "C" || id == "en-US-POSIX" { return nil }
        return String(id.prefix(64))
    }

    static func device(screen: Report.Screen?) -> Report.Device {
        Report.Device(platform: platform, osVersion: osVersion, model: model, screen: screen)
    }
}

/// Screen and UI context captured on the main thread by the platform layer;
/// read from any thread when a report is built.
final class PlatformSnapshot: @unchecked Sendable {
    static let shared = PlatformSnapshot()
    private let lock = NSLock()
    private var _screen: Report.Screen?
    private var _context: Report.Context?

    var screen: Report.Screen? {
        get { lock.locked { _screen } }
        set { lock.locked { _screen = newValue } }
    }

    var context: Report.Context? {
        get { lock.locked { _context } }
        set { lock.locked { _context = newValue } }
    }
}

enum ReportBuilder {
    static func make(
        prompt: String,
        extra: [String: String],
        metadata: [String: String],
        screenshotOmittedReason: String?,
        context: Report.Context?,
        screen: Report.Screen?,
        now: Date,
        id: String = Report.makeID()
    ) throws -> Report {
        try Report.validatePrompt(prompt)
        let merged = metadata.merging(extra) { _, explicit in explicit }
        let context = context.flatMap { $0.isEmpty ? nil : $0 }
        return Report(
            id: id,
            createdAt: Report.timestamp(now),
            prompt: prompt,
            sdk: Report.SDK(name: Fixr.sdkName, version: Fixr.sdkVersion),
            app: HostMetadata.app(),
            device: HostMetadata.device(screen: screen),
            locale: HostMetadata.locale,
            context: context,
            screenshotOmittedReason: screenshotOmittedReason,
            extra: Report.sanitizeExtra(merged)
        )
    }
}
