// swift-tools-version:5.9
import PackageDescription

// The platform-independent core (report types, encoder, multipart, response
// classification, retry policy, disk queue, uploader) builds everywhere,
// including Linux. Files under Sources/Fixr/Apple are guarded with
// `#if canImport(UIKit)` / `canImport(AppKit)` / `canImport(SwiftUI)` /
// `canImport(CoreGraphics)` and compile only on Apple platforms.
let package = Package(
    name: "Fixr",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "Fixr", targets: ["Fixr"]),
    ],
    targets: [
        .target(name: "Fixr", path: "Sources/Fixr"),
        .testTarget(name: "FixrTests", dependencies: ["Fixr"], path: "Tests/FixrTests"),
    ]
)
