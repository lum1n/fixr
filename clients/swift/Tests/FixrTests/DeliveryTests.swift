import Foundation
import XCTest
@testable import Fixr

final class DeliveryTests: XCTestCase {
    func testResponseTable() {
        XCTAssertEqual(ResponseClassifier.classify(status: 201), .delivered(duplicate: false))
        XCTAssertEqual(ResponseClassifier.classify(status: 200), .delivered(duplicate: true))
        for status in [400, 401, 403, 413, 422, 404, 409, 418] {
            XCTAssertEqual(ResponseClassifier.classify(status: status), .dropped(status: status), "\(status)")
        }
        for status in [408, 429, 500, 502, 503, 504, 599] {
            XCTAssertEqual(ResponseClassifier.classify(status: status), .retryLater(retryAfter: nil), "\(status)")
        }
        XCTAssertEqual(ResponseClassifier.classify(error: URLError(.notConnectedToInternet)), .retryLater(retryAfter: nil))
    }

    func testRetryAfterOnlyOn429And503() {
        XCTAssertEqual(ResponseClassifier.classify(status: 429, retryAfterHeader: "120"), .retryLater(retryAfter: 120))
        XCTAssertEqual(ResponseClassifier.classify(status: 503, retryAfterHeader: " 7 "), .retryLater(retryAfter: 7))
        XCTAssertEqual(ResponseClassifier.classify(status: 500, retryAfterHeader: "120"), .retryLater(retryAfter: nil))
        XCTAssertEqual(ResponseClassifier.classify(status: 429, retryAfterHeader: "Wed, 21 Oct 2026 07:28:00 GMT"),
                       .retryLater(retryAfter: nil))
        XCTAssertEqual(ResponseClassifier.classify(status: 429, retryAfterHeader: "-5"), .retryLater(retryAfter: nil))
    }

    func testRetrySchedule() {
        let policy = RetryPolicy()
        let expected: [TimeInterval] = [30, 120, 600, 3600, 21_600, 86_400, 86_400, 86_400]
        for (i, delay) in expected.enumerated() {
            XCTAssertEqual(policy.delay(afterFailedAttempt: i + 1), delay, "attempt \(i + 1)")
        }
        XCTAssertEqual(policy.delay(afterFailedAttempt: 19), 86_400)
        // Retry-After wins only when longer.
        XCTAssertEqual(policy.delay(afterFailedAttempt: 1, retryAfter: 300), 300)
        XCTAssertEqual(policy.delay(afterFailedAttempt: 1, retryAfter: 5), 30)
        XCTAssertEqual(policy.delay(afterFailedAttempt: 6, retryAfter: 100), 86_400)
    }

    func testExhaustion() {
        let policy = RetryPolicy()
        let created = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertFalse(policy.isExhausted(attempts: 19, createdAt: created, now: created))
        XCTAssertTrue(policy.isExhausted(attempts: 20, createdAt: created, now: created))
        XCTAssertFalse(policy.isExhausted(attempts: 0, createdAt: created, now: created.addingTimeInterval(7 * 86_400 - 1)))
        XCTAssertTrue(policy.isExhausted(attempts: 0, createdAt: created, now: created.addingTimeInterval(7 * 86_400)))
    }
}

final class ImageLadderTests: XCTestCase {
    /// Fake encoder: PNG costs 4 bytes/pixel, JPEG costs quality × 1 byte/pixel.
    private func fakeEncoder(log: UnsafeMutablePointer<[String]>? = nil) -> (Int, Int, ImageFormat) -> Data? {
        return { w, h, format in
            let pixels = w * h
            switch format {
            case .png:
                log?.pointee.append("png \(w)x\(h)")
                return Data(count: pixels * 4)
            case .jpeg(let q):
                log?.pointee.append("jpeg \(q) \(w)x\(h)")
                return Data(count: Int(Double(pixels) * q))
            }
        }
    }

    func testSmallImageIsPNGAtFullSize() {
        let result = ImageLadder.prepare(width: 300, height: 200, encode: fakeEncoder())
        guard case .image(let shot, let w, let h) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(shot.mime, .png)
        XCTAssertEqual([w, h], [300, 200])
    }

    func testDownscalesLongEdgeTo2000KeepingAspect() {
        var log: [String] = []
        let result = withUnsafeMutablePointer(to: &log) {
            ImageLadder.prepare(width: 4000, height: 1000, maxBytes: 100_000_000, encode: fakeEncoder(log: $0))
        }
        guard case .image(let shot, let w, let h) = result else { return XCTFail("\(result)") }
        XCTAssertEqual([w, h], [2000, 500])
        // maxBytes is clamped to the 2 MB wire limit: PNG (4 MB) misses, JPEG 0.9 fits.
        XCTAssertEqual(shot.mime, .jpeg)
        XCTAssertEqual(log, ["png 2000x500", "jpeg 0.9 2000x500"])
    }

    func testFallsBackToJPEGQualitiesInOrder() {
        // 1000x1000: PNG 4 MB, JPEG 0.9 = 900 kB, ... limit 650 kB → q 0.6 fits.
        var log: [String] = []
        let result = withUnsafeMutablePointer(to: &log) {
            ImageLadder.prepare(width: 1000, height: 1000, maxBytes: 650_000, encode: fakeEncoder(log: $0))
        }
        guard case .image(let shot, let w, _) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(shot.mime, .jpeg)
        XCTAssertEqual(shot.data.count, 600_000)
        XCTAssertEqual(w, 1000)
        XCTAssertEqual(log, ["png 1000x1000", "jpeg 0.9 1000x1000", "jpeg 0.8 1000x1000",
                             "jpeg 0.7 1000x1000", "jpeg 0.6 1000x1000"])
    }

    func testShrinksByThreeQuartersThenGivesUpBelow200() {
        // Limit 2 MB but JPEG 0.5 of 2000x2000 = 2 MB exactly → fits on first round.
        let fits = ImageLadder.prepare(width: 2000, height: 2000, encode: fakeEncoder())
        guard case .image(_, 2000, 2000) = fits else { return XCTFail("\(fits)") }

        // Needs a shrink: 0.5 × 2000² = 2 MB > 1.2 MB; 1500² × 0.5 = 1.125 MB fits.
        let shrunk = ImageLadder.prepare(width: 2000, height: 2000, maxBytes: 1_200_000, encode: fakeEncoder())
        guard case .image(let shot, 1500, 1500) = shrunk else { return XCTFail("\(shrunk)") }
        XCTAssertEqual(shot.mime, .jpeg)

        // Nothing ever fits: 2000 → 1500 → 1125 → 844 → 633 → 475 → 356 → 267 → 200 → (150 < 200) give up.
        var log: [String] = []
        let tooLarge = withUnsafeMutablePointer(to: &log) {
            ImageLadder.prepare(width: 2000, height: 2000, maxBytes: 10, encode: fakeEncoder(log: $0))
        }
        XCTAssertEqual(tooLarge, .tooLarge)
        let sizes = log.filter { $0.hasPrefix("png") }
        XCTAssertEqual(sizes.first, "png 2000x2000")
        XCTAssertEqual(sizes.last, "png 200x200")
    }

    func testEncoderFailureIsCaptureFailed() {
        XCTAssertEqual(ImageLadder.prepare(width: 100, height: 100) { _, _, _ in nil }, .failed)
        XCTAssertEqual(ImageLadder.prepare(width: 0, height: 100) { _, _, _ in Data() }, .failed)
    }

    func testConfiguredLimitsAreClampedToSpec() {
        let result = ImageLadder.prepare(width: 5000, height: 100, maxDimension: 9000, maxBytes: 100_000_000,
                                         encode: fakeEncoder())
        guard case .image(_, 2000, 40) = result else { return XCTFail("\(result)") }
    }
}
