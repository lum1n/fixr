import Foundation
import XCTest
@testable import Fixr

final class ReportTests: XCTestCase {
    /// The document from spec/fixtures/report.v1.json, built field by field.
    static let golden = Report(
        id: "0b9f6c1e-3c1a-4d2b-9a57-5f3d2c1b0a99",
        createdAt: "2026-11-05T14:03:12Z",
        prompt: "The Save button is misaligned with Cancel; make them the same height.",
        sdk: .init(name: "fixr-test", version: "0.1.0"),
        app: .init(id: "com.example.notes", version: "1.4.2", build: "231"),
        device: .init(platform: "macos", osVersion: "15.1", model: "Mac15,6",
                      screen: .init(width: 1512, height: 982, scale: 2)),
        locale: "en-US",
        context: .init(screen: "EditorViewController", title: "Untitled", url: "https://notes.example.com/doc/42"),
        screenshotOmittedReason: "user_removed",
        extra: ["branch": "main", "user_tier": "beta"]
    )

    func testEncodesToGoldenFixture() throws {
        let fixture = try Data(contentsOf: Paths.fixture)
        let encoded = try ReportEncoder.encode(Self.golden)
        XCTAssertEqual(try jsonObject(encoded), try jsonObject(fixture))
    }

    func testDecodesGoldenFixtureAndRoundTrips() throws {
        let fixture = try Data(contentsOf: Paths.fixture)
        let decoded = try ReportEncoder.decode(fixture)
        XCTAssertEqual(decoded, Self.golden)
        XCTAssertEqual(try jsonObject(ReportEncoder.encode(decoded)), try jsonObject(fixture))
    }

    func testEncodingIsDeterministic() throws {
        let a = try ReportEncoder.encode(Self.golden)
        let b = try ReportEncoder.encode(Self.golden)
        XCTAssertEqual(a, b)
        let text = String(decoding: a, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix(#"{"app":{"build":"231","id":"com.example.notes","version":"1.4.2"},"context":"#), text)
        XCTAssertTrue(text.contains(#""url":"https://notes.example.com/doc/42""#), "slashes must not be escaped")
    }

    func testOptionalsAreOmittedNotNull() throws {
        let data = try ReportEncoder.encode(.sample(id: "0b9f6c1e-3c1a-4d2b-9a57-5f3d2c1b0a99"))
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains("null"), text)
        let object = try jsonObject(data)
        XCTAssertEqual(Set(object.allKeys as! [String]), ["schema", "id", "created_at", "prompt", "sdk", "app", "device"])
        XCTAssertEqual(object["app"] as? NSDictionary, ["id": "com.example.tests"])
        XCTAssertEqual(object["device"] as? NSDictionary, ["platform": "linux"])
        XCTAssertEqual(object["schema"] as? Int, 1)
    }

    func testTimestampIsUTCWholeSeconds() {
        let date = Date(timeIntervalSince1970: 1_793_887_392.75) // 2026-11-05T14:03:12.75Z
        XCTAssertEqual(Report.timestamp(date), "2026-11-05T14:03:12Z")
        XCTAssertEqual(Report.timestamp(Date(timeIntervalSince1970: 0)), "1970-01-01T00:00:00Z")
        XCTAssertEqual(Uploader.parseTimestamp("2026-11-05T14:03:12Z"), Date(timeIntervalSince1970: 1_793_887_392))
    }

    func testIDIsLowercaseUUIDv4() {
        for _ in 0..<50 {
            let id = Report.makeID()
            XCTAssertTrue(DiskQueue.isValidID(id), id)
            let scalars = Array(id)
            XCTAssertEqual(scalars[14], "4")
            XCTAssertTrue("89ab".contains(scalars[19]))
        }
    }

    func testPromptValidation() {
        XCTAssertThrowsError(try Report.validatePrompt("")) { XCTAssertEqual($0 as? FixrError, .emptyPrompt) }
        XCTAssertThrowsError(try Report.validatePrompt(" \n\t")) { XCTAssertEqual($0 as? FixrError, .emptyPrompt) }
        XCTAssertNoThrow(try Report.validatePrompt(String(repeating: "a", count: 4000)))
        XCTAssertThrowsError(try Report.validatePrompt(String(repeating: "a", count: 4001))) {
            XCTAssertEqual($0 as? FixrError, .promptTooLong(scalars: 4001))
        }
        // Unicode scalars, not UTF-16 units or grapheme clusters.
        XCTAssertNoThrow(try Report.validatePrompt(String(repeating: "😀", count: 4000)))
    }

    func testExtraIsClampedToWireLimits() throws {
        var extra: [String: String] = [:]
        for i in 0..<40 { extra[String(format: "k%02d", i)] = "v" }
        extra[String(repeating: "x", count: 65)] = "dropped"
        extra["long"] = String(repeating: "y", count: 1500)
        let out = try XCTUnwrap(Report.sanitizeExtra(extra))
        XCTAssertEqual(out.count, 32)
        XCTAssertNil(out[String(repeating: "x", count: 65)])
        XCTAssertEqual(out["k00"], "v")
        XCTAssertTrue(out.keys.allSatisfy { $0.count <= 64 })
        XCTAssertTrue(out.values.allSatisfy { $0.count <= 1000 })
        XCTAssertNil(Report.sanitizeExtra([:]))
        XCTAssertEqual(Report.sanitizeExtra(["long": String(repeating: "y", count: 1500)])?["long"]?.count, 1000)
    }

    func testBuilderMergesMetadataAndOmitsEmptyContext() throws {
        let report = try ReportBuilder.make(
            prompt: "hello", extra: ["a": "explicit"], metadata: ["a": "meta", "b": "meta"],
            screenshotOmittedReason: nil, context: Report.Context(), screen: nil,
            now: Date(timeIntervalSince1970: 1_793_887_392)
        )
        XCTAssertEqual(report.extra, ["a": "explicit", "b": "meta"])
        XCTAssertNil(report.context)
        XCTAssertEqual(report.sdk, Report.SDK(name: "fixr-swift", version: "0.1.0"))
        XCTAssertEqual(report.createdAt, "2026-11-05T14:03:12Z")
        XCTAssertFalse(report.app.id.isEmpty)
        XCTAssertTrue(["ios", "macos", "linux", "windows"].contains(report.device.platform))
        if let locale = report.locale { XCTAssertFalse(locale.contains("_")) }
        XCTAssertEqual(Fixr.userAgent, "fixr-swift/0.1.0")
    }
}
