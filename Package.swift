// swift-tools-version:5.9
import PackageDescription

// Root manifest so apps can depend on the Swift client by git URL
// (`.package(url: "https://github.com/lum1n/fixr.git", ...)`); SwiftPM
// can't point a URL at a subdirectory. Tests and the example live in
// clients/swift/Package.swift.
let package = Package(
    name: "Fixr",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "Fixr", targets: ["Fixr"]),
    ],
    targets: [
        .target(name: "Fixr", path: "clients/swift/Sources/Fixr"),
    ]
)
