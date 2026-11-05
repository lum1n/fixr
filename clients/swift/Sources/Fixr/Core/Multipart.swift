import Foundation

/// A `multipart/form-data` body with exactly the parts the wire format allows,
/// in order: `report` (application/json), then optional `screenshot`.
public struct MultipartBody: Equatable, Sendable {
    public let boundary: String
    public let data: Data

    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    public static func build(reportJSON: Data, screenshot: FixrScreenshot?, boundary: String? = nil) -> MultipartBody {
        var boundary = boundary ?? makeBoundary()
        // Practically impossible, but never emit a boundary that occurs in a part.
        while reportJSON.range(of: Data(boundary.utf8)) != nil
            || (screenshot?.data.range(of: Data(boundary.utf8)) != nil) {
            boundary = makeBoundary()
        }
        var body = Data()
        func append(_ s: String) { body.append(contentsOf: Array(s.utf8)) }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"report\"\r\n")
        append("Content-Type: application/json\r\n\r\n")
        body.append(reportJSON)
        append("\r\n")
        if let screenshot {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"screenshot\"; filename=\"\(screenshot.filename)\"\r\n")
            append("Content-Type: \(screenshot.mime.rawValue)\r\n\r\n")
            body.append(screenshot.data)
            append("\r\n")
        }
        append("--\(boundary)--\r\n")
        return MultipartBody(boundary: boundary, data: body)
    }

    static func makeBoundary() -> String {
        "fixr-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
    }
}

/// The `application/json` alternative body: the report with a base64
/// `screenshot` member. Multipart is the default; this exists for parity.
public enum JSONBody {
    public static func build(report: Report, screenshot: FixrScreenshot?) throws -> Data {
        let reportJSON = try ReportEncoder.encode(report)
        guard let screenshot else { return reportJSON }
        guard var object = try JSONSerialization.jsonObject(with: reportJSON) as? [String: Any] else {
            return reportJSON
        }
        object["screenshot"] = ["mime": screenshot.mime.rawValue, "data": screenshot.data.base64EncodedString()]
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    }
}
