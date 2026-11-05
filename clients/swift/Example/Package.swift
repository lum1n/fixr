// swift-tools-version:5.9
// Apple-only example. macOS: `swift run` from this directory. iOS: see README.
import PackageDescription

let package = Package(
    name: "FixrExample",
    platforms: [.iOS(.v17), .macOS(.v14)],
    dependencies: [.package(path: "..")],
    targets: [
        .executableTarget(
            name: "FixrExample",
            // The path dependency's identity is its directory name, `swift`.
            dependencies: [.product(name: "Fixr", package: "swift")],
            path: "Sources/FixrExample"
        ),
    ]
)
