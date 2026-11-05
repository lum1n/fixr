import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What the client does with a report after an upload attempt
/// (spec/wire-format.md, "Responses").
public enum DeliveryOutcome: Equatable, Sendable {
    /// 201, or 200 with `duplicate: true`: delete from the queue.
    case delivered(duplicate: Bool)
    /// 408, 429, 5xx or a network error: keep and retry. `retryAfter` is the
    /// `Retry-After` header in seconds (honoured on 429/503 only).
    case retryLater(retryAfter: TimeInterval?)
    /// Any other 4xx: permanent, drop. `status` is nil for client-side drops
    /// (attempt limit or age reached).
    case dropped(status: Int?)
}

public enum ResponseClassifier {
    public static func classify(status: Int, retryAfterHeader: String? = nil) -> DeliveryOutcome {
        switch status {
        case 201: return .delivered(duplicate: false)
        case 200: return .delivered(duplicate: true)
        case 202...299: return .delivered(duplicate: false)
        case 408, 500...599:
            return .retryLater(retryAfter: status == 503 ? parseRetryAfter(retryAfterHeader) : nil)
        case 429:
            return .retryLater(retryAfter: parseRetryAfter(retryAfterHeader))
        case 400...499: return .dropped(status: status)
        default:
            // 1xx/3xx reaching us means something in between misbehaved; try again later.
            return .retryLater(retryAfter: nil)
        }
    }

    /// Network errors (no HTTP response) are always retried.
    public static func classify(error: Error) -> DeliveryOutcome { .retryLater(retryAfter: nil) }

    /// `Retry-After` in delta-seconds. HTTP-date values are ignored.
    static func parseRetryAfter(_ value: String?) -> TimeInterval? {
        guard let raw = value?.trimmingCharacters(in: .whitespaces), let seconds = Double(raw),
              seconds.isFinite, seconds >= 0 else { return nil }
        return seconds
    }

    static func classify(response: URLResponse?, error: Error?) -> DeliveryOutcome {
        if let error { return classify(error: error) }
        guard let http = response as? HTTPURLResponse else { return .retryLater(retryAfter: nil) }
        return classify(status: http.statusCode, retryAfterHeader: http.value(forHTTPHeaderField: "Retry-After"))
    }
}

/// Source of "now", injectable for tests.
public protocol FixrClock: Sendable {
    func now() -> Date
}

public struct SystemClock: FixrClock {
    public init() {}
    public func now() -> Date { Date() }
}

/// Retry schedule from spec/wire-format.md: delays after attempt n fails are
/// 30 s, 2 min, 10 min, 1 h, 6 h, then every 24 h. Dropped after 20 attempts
/// or 7 days after `created_at`, whichever comes first.
public struct RetryPolicy: Equatable, Sendable {
    public var delays: [TimeInterval] = [30, 120, 600, 3600, 21_600]
    public var steadyDelay: TimeInterval = 86_400
    public var maxAttempts = 20
    public var maxAge: TimeInterval = 7 * 86_400

    public init() {}

    /// Delay before the next attempt after `attempt` (1-based) failed.
    /// A `Retry-After` overrides the table only when it is longer.
    public func delay(afterFailedAttempt attempt: Int, retryAfter: TimeInterval? = nil) -> TimeInterval {
        let index = max(1, attempt) - 1
        let base = index < delays.count ? delays[index] : steadyDelay
        if let retryAfter, retryAfter > base { return retryAfter }
        return base
    }

    /// True when the report must be dropped instead of retried.
    public func isExhausted(attempts: Int, createdAt: Date, now: Date) -> Bool {
        attempts >= maxAttempts || now.timeIntervalSince(createdAt) >= maxAge
    }
}
