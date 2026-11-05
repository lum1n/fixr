// Apple-only (not compiled on Linux).
#if canImport(SwiftUI) && canImport(CoreGraphics) && (canImport(UIKit) || canImport(AppKit)) && !os(watchOS)
import CoreGraphics
import SwiftUI

/// State for the report sheet. Redaction rects are stored in image pixels
/// with a top-left origin.
@MainActor
final class ReportSheetModel: ObservableObject {
    @Published var prompt = ""
    @Published var redactions: [CGRect] = []
    @Published var includeScreenshot = true

    let image: CGImage?
    let allowRedaction: Bool

    /// `(prompt, final image or nil, screenshot_omitted_reason)`.
    var onSend: @MainActor (String, CGImage?, String?) -> Void = { _, _, _ in }
    var onCancel: @MainActor () -> Void = {}

    init(image: CGImage?, allowRedaction: Bool) {
        self.image = image
        self.allowRedaction = allowRedaction
    }

    var promptScalars: Int { prompt.unicodeScalars.count }

    var canSend: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && promptScalars <= FixrLimits.promptMaxScalars
    }

    func send() {
        guard canSend else { return }
        guard let image else {
            onSend(prompt, nil, ScreenshotOmittedReason.captureFailed)
            return
        }
        guard includeScreenshot else {
            onSend(prompt, nil, ScreenshotOmittedReason.userRemoved)
            return
        }
        // Never fall back to the unredacted image.
        guard let final = Redaction.burnIn(image, rects: redactions) else {
            onSend(prompt, nil, "redaction_failed")
            return
        }
        onSend(prompt, final, nil)
    }
}

@MainActor
enum Redaction {
    /// Burns black rectangles into the pixels with `ImageRenderer` (falls back
    /// to a CoreGraphics fill). Returns the input untouched when there is
    /// nothing to redact.
    static func burnIn(_ image: CGImage, rects: [CGRect]) -> CGImage? {
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        let rects = rects.map { $0.intersection(bounds) }.filter { !$0.isNull && !$0.isEmpty }
        guard !rects.isEmpty else { return image }
        let content = ZStack(alignment: .topLeading) {
            Image(decorative: image, scale: 1)
            ForEach(Array(rects.enumerated()), id: \.offset) { _, r in
                Rectangle()
                    .fill(Color.black)
                    .frame(width: r.width, height: r.height)
                    .offset(x: r.minX, y: r.minY)
            }
        }
        .frame(width: bounds.width, height: bounds.height, alignment: .topLeading)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 1
        renderer.proposedSize = ProposedViewSize(bounds.size)
        if let rendered = renderer.cgImage, rendered.width == image.width, rendered.height == image.height {
            return rendered
        }
        return ImageCodec.fill(image, blackRects: rects)
    }
}

@MainActor
struct ReportSheetView: View {
    @ObservedObject var model: ReportSheetModel
    @State private var dragRect: CGRect?
    @FocusState private var promptFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Report a problem").font(.headline)
            screenshotSection
            promptSection
            footer
        }
        .padding(16)
        .frame(minWidth: 320, idealWidth: 640, minHeight: 420, idealHeight: 560)
        .onAppear { promptFocused = true }
    }

    @ViewBuilder
    private var screenshotSection: some View {
        if let image = model.image {
            if model.includeScreenshot {
                preview(image)
                    .frame(maxWidth: .infinity, minHeight: 160, maxHeight: .infinity)
            }
            HStack(spacing: 12) {
                Toggle("Include screenshot", isOn: $model.includeScreenshot)
                Spacer()
                if model.allowRedaction && model.includeScreenshot {
                    Text("Drag to black out").font(.caption).foregroundStyle(.secondary)
                    Button("Undo") { _ = model.redactions.popLast() }
                        .disabled(model.redactions.isEmpty)
                }
            }
        } else {
            Label("Screenshot unavailable", systemImage: "photo")
                .foregroundStyle(.secondary)
        }
    }

    private func preview(_ image: CGImage) -> some View {
        GeometryReader { geo in
            let pixelWidth = CGFloat(image.width)
            let pixelHeight = CGFloat(image.height)
            let scale = max(0.0001, min(geo.size.width / pixelWidth, geo.size.height / pixelHeight))
            let shown = CGSize(width: pixelWidth * scale, height: pixelHeight * scale)
            ZStack(alignment: .topLeading) {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.medium)
                    .frame(width: shown.width, height: shown.height)
                ForEach(Array(model.redactions.enumerated()), id: \.offset) { _, r in
                    Rectangle()
                        .fill(Color.black)
                        .frame(width: r.width * scale, height: r.height * scale)
                        .offset(x: r.minX * scale, y: r.minY * scale)
                }
                if let d = dragRect {
                    Rectangle()
                        .fill(Color.black.opacity(0.6))
                        .frame(width: d.width, height: d.height)
                        .offset(x: d.minX, y: d.minY)
                }
            }
            .frame(width: shown.width, height: shown.height, alignment: .topLeading)
            .clipped()
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.4)))
            .contentShape(Rectangle())
            .gesture(redactionGesture(scale: scale, shown: shown), including: model.allowRedaction ? .all : .none)
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    private func redactionGesture(scale: CGFloat, shown: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 3, coordinateSpace: .local)
            .onChanged { value in
                dragRect = Self.rect(value.startLocation, value.location, within: shown)
            }
            .onEnded { value in
                let r = Self.rect(value.startLocation, value.location, within: shown)
                dragRect = nil
                guard let r, r.width >= 2, r.height >= 2 else { return }
                model.redactions.append(CGRect(x: r.minX / scale, y: r.minY / scale,
                                               width: r.width / scale, height: r.height / scale))
            }
    }

    private static func rect(_ a: CGPoint, _ b: CGPoint, within size: CGSize) -> CGRect? {
        let r = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
            .intersection(CGRect(origin: .zero, size: size))
        return r.isNull ? nil : r
    }

    private var promptSection: some View {
        TextEditor(text: $model.prompt)
            .focused($promptFocused)
            .font(.body)
            .frame(minHeight: 80, maxHeight: 160)
            .overlay(alignment: .topLeading) {
                if model.prompt.isEmpty {
                    Text("What should change?")
                        .foregroundStyle(.tertiary)
                        .padding(.top, 8)
                        .padding(.leading, 5)
                        .allowsHitTesting(false)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
    }

    private var footer: some View {
        HStack {
            Text("\(model.promptScalars)/\(FixrLimits.promptMaxScalars)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(model.promptScalars > FixrLimits.promptMaxScalars ? Color.red : Color.secondary)
            Spacer()
            Button("Cancel", role: .cancel) { model.onCancel() }
                .keyboardShortcut(.cancelAction)
            Button("Send") { model.send() }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(!model.canSend)
        }
    }
}
#endif
