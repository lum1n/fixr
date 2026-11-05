import MetalKit
import QuartzCore
import SwiftUI

/// Animates the clear colour of an `MTKView`. `framebufferOnly = false` is what
/// makes Metal content visible to `drawHierarchy` on iOS; on macOS the
/// window-server capture sees it regardless.
final class ClearColorRenderer: NSObject, MTKViewDelegate {
    private let queue: MTLCommandQueue?
    private let start = CACurrentMediaTime()

    init(device: MTLDevice?) {
        queue = device?.makeCommandQueue()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let t = CACurrentMediaTime() - start
        view.clearColor = MTLClearColor(red: 0.5 + 0.5 * sin(t), green: 0.35, blue: 0.5 + 0.5 * cos(t * 0.7), alpha: 1)
        guard let pass = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let buffer = queue?.makeCommandBuffer(),
              let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.endEncoding()
        buffer.present(drawable)
        buffer.commit()
    }
}

private func makeMetalView(delegate: ClearColorRenderer, device: MTLDevice?) -> MTKView {
    let view = MTKView(frame: .zero, device: device)
    view.framebufferOnly = false
    view.preferredFramesPerSecond = 30
    view.delegate = delegate
    return view
}

#if os(iOS)
struct MetalClearView: UIViewRepresentable {
    private let device = MTLCreateSystemDefaultDevice()

    func makeCoordinator() -> ClearColorRenderer { ClearColorRenderer(device: device) }
    func makeUIView(context: Context) -> MTKView { makeMetalView(delegate: context.coordinator, device: device) }
    func updateUIView(_ view: MTKView, context: Context) {}
}
#else
struct MetalClearView: NSViewRepresentable {
    private let device = MTLCreateSystemDefaultDevice()

    func makeCoordinator() -> ClearColorRenderer { ClearColorRenderer(device: device) }
    func makeNSView(context: Context) -> MTKView { makeMetalView(delegate: context.coordinator, device: device) }
    func updateNSView(_ view: MTKView, context: Context) {}
}
#endif
