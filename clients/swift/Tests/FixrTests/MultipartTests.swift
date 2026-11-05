import Foundation
import XCTest
@testable import Fixr

final class MultipartTests: XCTestCase {
    func testReportThenScreenshotPartsInOrder() throws {
        let json = Data(#"{"schema":1}"#.utf8)
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF])
        let body = MultipartBody.build(reportJSON: json, screenshot: FixrScreenshot(data: png, mime: .png),
                                       boundary: "fixr-test-boundary")
        XCTAssertEqual(body.contentType, "multipart/form-data; boundary=fixr-test-boundary")

        var expected = Data()
        expected.append(Data("--fixr-test-boundary\r\nContent-Disposition: form-data; name=\"report\"\r\nContent-Type: application/json\r\n\r\n".utf8))
        expected.append(json)
        expected.append(Data("\r\n--fixr-test-boundary\r\nContent-Disposition: form-data; name=\"screenshot\"; filename=\"screenshot.png\"\r\nContent-Type: image/png\r\n\r\n".utf8))
        expected.append(png)
        expected.append(Data("\r\n--fixr-test-boundary--\r\n".utf8))
        XCTAssertEqual(body.data, expected)

        let parts = parseMultipart(body.data, boundary: body.boundary)
        XCTAssertEqual(parts.count, 2)
        XCTAssertTrue(parts[0].headers.contains(#"name="report""#))
        XCTAssertEqual(parts[0].body, json)
        XCTAssertTrue(parts[1].headers.contains(#"filename="screenshot.png""#))
        XCTAssertEqual(parts[1].body, png)
    }

    func testReportOnlyAndJPEGFilename() {
        let json = Data("{}".utf8)
        let only = MultipartBody.build(reportJSON: json, screenshot: nil, boundary: "b")
        XCTAssertEqual(String(decoding: only.data, as: UTF8.self),
                       "--b\r\nContent-Disposition: form-data; name=\"report\"\r\nContent-Type: application/json\r\n\r\n{}\r\n--b--\r\n")
        let jpeg = MultipartBody.build(reportJSON: json, screenshot: FixrScreenshot(data: Data([1]), mime: .jpeg), boundary: "b")
        let text = String(decoding: jpeg.data, as: UTF8.self)
        XCTAssertTrue(text.contains(#"filename="screenshot.jpg""#))
        XCTAssertTrue(text.contains("Content-Type: image/jpeg"))
    }

    func testBoundaryNeverOccursInContent() {
        let body = MultipartBody.build(reportJSON: Data("--clash--".utf8), screenshot: nil, boundary: "clash")
        XCTAssertNotEqual(body.boundary, "clash")
        XCTAssertTrue(body.boundary.hasPrefix("fixr-"))
        XCTAssertEqual(parseMultipart(body.data, boundary: body.boundary).first?.body, Data("--clash--".utf8))
    }

    func testJSONBodyCarriesBase64Screenshot() throws {
        let report = Report.sample()
        let data = try JSONBody.build(report: report, screenshot: FixrScreenshot(data: Data([1, 2, 3]), mime: .png))
        let object = try jsonObject(data)
        XCTAssertEqual(object["screenshot"] as? NSDictionary, ["mime": "image/png", "data": "AQID"])
        XCTAssertEqual(object["id"] as? String, report.id)
    }
}
