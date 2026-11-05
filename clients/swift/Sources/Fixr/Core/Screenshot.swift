import Foundation

/// Encoded screenshot bytes ready to upload.
public struct FixrScreenshot: Equatable, Sendable {
    public enum MIME: String, Sendable {
        case png = "image/png"
        case jpeg = "image/jpeg"

        public var fileExtension: String { self == .png ? "png" : "jpg" }
    }

    public var data: Data
    public var mime: MIME

    public init(data: Data, mime: MIME) {
        self.data = data
        self.mime = mime
    }

    public var filename: String { "screenshot.\(mime.fileExtension)" }
}

/// Encoding requested by the image ladder.
public enum ImageFormat: Equatable, Sendable {
    case png
    case jpeg(quality: Double)
}

/// The image preparation ladder from spec/wire-format.md, independent of any
/// image library: the caller supplies `encode(width, height, format)`, which
/// scales the source to exactly `width`×`height` and encodes it.
///
/// 1. Downscale so the long edge is ≤ `maxDimension` (keep aspect ratio).
/// 2. Encode PNG. If ≤ `maxBytes`, done.
/// 3. Encode JPEG at 0.9, 0.8, 0.7, 0.6, 0.5; the first that fits wins.
/// 4. Scale by ×0.75 and go to 2. Give up below 200 px long edge (`too_large`).
public enum ImageLadder {
    public static let jpegQualities: [Double] = [0.9, 0.8, 0.7, 0.6, 0.5]
    public static let stepScale = 0.75

    public enum Result: Equatable, Sendable {
        case image(FixrScreenshot, width: Int, height: Int)
        /// Nothing fit; send `screenshot_omitted_reason: "too_large"`.
        case tooLarge
        /// The encoder failed on every attempt; send `capture_failed`.
        case failed
    }

    public static func prepare(
        width: Int,
        height: Int,
        maxDimension: Int = FixrLimits.imageMaxDimension,
        maxBytes: Int = FixrLimits.imageMaxBytes,
        minDimension: Int = FixrLimits.imageMinDimension,
        encode: (_ width: Int, _ height: Int, _ format: ImageFormat) -> Data?
    ) -> Result {
        guard width > 0, height > 0 else { return .failed }
        let maxDimension = min(max(1, maxDimension), FixrLimits.imageMaxDimension)
        let maxBytes = min(max(1, maxBytes), FixrLimits.imageMaxBytes)
        let longEdge = Double(max(width, height))
        var scale = min(1.0, Double(maxDimension) / longEdge)
        var encodedAnything = false

        while true {
            let w = max(1, Int((Double(width) * scale).rounded()))
            let h = max(1, Int((Double(height) * scale).rounded()))
            if let png = encode(w, h, .png) {
                encodedAnything = true
                if png.count <= maxBytes { return .image(FixrScreenshot(data: png, mime: .png), width: w, height: h) }
            }
            for q in jpegQualities {
                if let jpeg = encode(w, h, .jpeg(quality: q)) {
                    encodedAnything = true
                    if jpeg.count <= maxBytes { return .image(FixrScreenshot(data: jpeg, mime: .jpeg), width: w, height: h) }
                }
            }
            // An encoder that produces nothing will not start working at a smaller size.
            if !encodedAnything { return .failed }
            scale *= stepScale
            if longEdge * scale < Double(minDimension) { return .tooLarge }
        }
    }
}
