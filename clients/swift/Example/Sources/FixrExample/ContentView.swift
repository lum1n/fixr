import Fixr
import SwiftUI

struct ContentView: View {
    @State private var title = "Untitled"
    @State private var status: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Fixr Example").font(.largeTitle.bold())
                Text(triggerHint).foregroundStyle(.secondary)

                TextField("Title", text: $title)
                    .textFieldStyle(.roundedBorder)

                // Deliberately broken: Save sits lower and is taller than Cancel.
                // This is the bug to report ("make Save line up with Cancel").
                HStack(alignment: .top, spacing: 12) {
                    Button("Cancel") {}
                        .buttonStyle(.bordered)
                    Button("Save") {}
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .padding(.top, 9)
                }

                MetalClearView()
                    .frame(height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                Text("An MTKView with framebufferOnly = false: its pixels must show up in the screenshot.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 12) {
                    Button("Report a problem…") { Fixr.present() }
                        .buttonStyle(.borderedProminent)
                    Button("Send without UI") {
                        do {
                            let id = try Fixr.send(prompt: "Test report from the example app", extra: ["source": "button"])
                            status = "Queued \(id)"
                        } catch {
                            status = "Not sent: \(error)"
                        }
                    }
                    Button("Flush queue") { Fixr.flush() }
                }

                if let status {
                    Text(status).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
            .padding(24)
        }
    }

    private var triggerHint: String {
        #if os(macOS)
        return "Press ⌘⇧F to report a problem with this window."
        #else
        return "Shake the device (or Device ▸ Shake in the simulator) to report a problem."
        #endif
    }
}
