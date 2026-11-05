import Fixr
import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

#if os(iOS)
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        if !Fixr.handleEventsForBackgroundURLSession(identifier: identifier, completionHandler: completionHandler) {
            completionHandler()
        }
    }
}
#endif

@main
struct FixrExampleApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    init() {
        let env = ProcessInfo.processInfo.environment
        // Point at `node spec/echo-server/server.mjs --port 8787` or `wrangler dev`.
        let endpoint = env["FIXR_ENDPOINT"].flatMap(URL.init(string:)) ?? URL(string: "http://localhost:8787")!
        Fixr.configure(FixrConfiguration(
            endpoint: endpoint,
            projectKey: env["FIXR_PROJECT_KEY"] ?? "pk_dev",
            trigger: [.keyboardShortcut, .shakeSwizzle],
            metadataProvider: { ["example": "FixrExample"] }
        ))
        #if os(macOS)
        // Needed when launched with `swift run` (no app bundle).
        NSApplication.shared.setActivationPolicy(.regular)
        #endif
    }

    var body: some Scene {
        WindowGroup("Fixr Example") {
            ContentView()
                #if os(macOS)
                .frame(minWidth: 520, minHeight: 520)
                .onAppear { NSApplication.shared.activate() }
                #endif
        }
    }
}
