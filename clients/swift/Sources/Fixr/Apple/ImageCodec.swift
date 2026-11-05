// Apple-only (not compiled on Linux).
#if canImport(CoreGraphics) && canImport(ImageIO)
import CoreGraphics
import Foundation
import ImageIO

/// CoreGraphics/ImageIO implementation of the encode step used by `ImageLadder`.
enum ImageCodec {
    static func prepare(_ image: CGImage, maxDimension: Int, maxBytes: Int) -> ImageLadder.Result {
        var cache: (width: Int, height: Int, opaque: Bool, image: CGImage)?
        return ImageLadder.prepare(width: image.width, height: image.height,
                                   maxDimension: maxDimension, maxBytes: maxBytes) { width, height, format in
            let opaque = format != .png
            let scaled: CGImage
            if let cache, cache.width == width, cache.height == height, cache.opaque == opaque {
                scaled = cache.image
            } else {
                guard let made = scale(image, width: width, height: height, opaque: opaque) else { return nil }
                cache = (width, height, opaque, made)
                scaled = made
            }
            return encode(scaled, format: format)
        }
    }

    /// Scales to exactly `width`×`height`. JPEG input is flattened on white.
    static func scale(_ image: CGImage, width: Int, height: Int, opaque: Bool) -> CGImage? {
        if !opaque, image.width == width, image.height == height { return image }
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: space, bitmapInfo: info) else { return nil }
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        context.interpolationQuality = .high
        if opaque {
            context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
            context.fill(rect)
        }
        context.draw(image, in: rect)
        return context.makeImage()
    }

    static func encode(_ image: CGImage, format: ImageFormat) -> Data? {
        let data = NSMutableData()
        let type = (format == .png ? "public.png" : "public.jpeg") as CFString
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, type, 1, nil) else { return nil }
        var options: [CFString: Any] = [:]
        if case .jpeg(let quality) = format {
            options[kCGImageDestinationLossyCompressionQuality] = quality
        }
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// True when every pixel of a 16×16 thumbnail has zero alpha (what a
    /// failed window capture typically returns).
    static func isFullyTransparent(_ image: CGImage) -> Bool {
        let side = 16
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8,
                                          bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        guard drawn else { return false }
        return stride(from: 3, to: pixels.count, by: 4).allSatisfy { pixels[$0] == 0 }
    }

    /// Fallback redaction burn-in when `ImageRenderer` returns nil.
    /// `rects` use a top-left origin in image pixels.
    static func fill(_ image: CGImage, blackRects rects: [CGRect]) -> CGImage? {
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let height = CGFloat(image.height)
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        for r in rects {
            context.fill(CGRect(x: r.minX, y: height - r.maxY, width: r.width, height: r.height))
        }
        return context.makeImage()
    }
}

/// Prepares a captured/redacted image and queues the report off the main thread.
enum FixrSubmission {
    static func submit(prompt: String, image: CGImage?, omittedReason: String?,
                       context: Report.Context?, configuration: FixrConfiguration) {
        DispatchQueue.global(qos: .userInitiated).async {
            let (screenshot, reason) = prepared(image, omittedReason: omittedReason, configuration: configuration)
            _ = try? Fixr.submit(prompt: prompt, screenshot: screenshot, omittedReason: reason,
                                 extra: [:], context: context)
        }
    }

    static func prepared(_ image: CGImage?, omittedReason: String?,
                         configuration: FixrConfiguration) -> (FixrScreenshot?, String?) {
        guard let image else { return (nil, omittedReason) }
        switch ImageCodec.prepare(image, maxDimension: configuration.maxImageDimension,
                                  maxBytes: configuration.maxImageBytes) {
        case .image(let screenshot, _, _): return (screenshot, nil)
        case .tooLarge: return (nil, ScreenshotOmittedReason.tooLarge)
        case .failed: return (nil, ScreenshotOmittedReason.captureFailed)
        }
    }
}

extension Fixr {
    /// Queues a report with a `CGImage` screenshot, run through the image
    /// ladder (downscale, PNG, then JPEG 0.9…0.5, then shrink). Synchronous
    /// encoding: call off the main thread for large images.
    @discardableResult
    public static func send(prompt: String, image: CGImage, extra: [String: String] = [:]) throws -> String {
        guard let configuration = FixrRuntime.shared.configuration else { throw FixrError.notConfigured }
        try Report.validatePrompt(prompt)
        let (screenshot, reason) = FixrSubmission.prepared(image, omittedReason: nil, configuration: configuration)
        return try submit(prompt: prompt, screenshot: screenshot, omittedReason: reason, extra: extra)
    }
}
#endif
