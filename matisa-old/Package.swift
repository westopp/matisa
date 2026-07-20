// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Matisa",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Matisa", targets: ["Matisa"]),
        .executable(name: "matisa-engine", targets: ["MatisaEngine"]),
        // Product name is `matisa-cli` (not `matisa`) so it doesn't collide
        // with the `Matisa` app product on case-insensitive APFS — swift
        // build puts both binaries in the same directory, and `matisa` /
        // `Matisa` resolve to the same path. The build-app.sh script
        // renames the binary back to `matisa` when placing it in the
        // bundle at `Contents/Resources/bin/matisa`.
        .executable(name: "matisa-cli", targets: ["MatisaCLI"])
    ],
    targets: [
        .target(
            name: "MatisaCore",
            path: "Sources/MatisaCore"
        ),
        .executableTarget(
            name: "Matisa",
            dependencies: ["MatisaCore"],
            path: "Sources/Matisa"
        ),
        .executableTarget(
            name: "MatisaEngine",
            dependencies: ["MatisaCore"],
            path: "Sources/MatisaEngine"
        ),
        .executableTarget(
            name: "MatisaCLI",
            dependencies: ["MatisaCore"],
            path: "Sources/MatisaCLI"
        ),
        .testTarget(
            name: "MatisaTests",
            dependencies: ["Matisa", "MatisaCore"],
            path: "Tests/MatisaTests",
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "MatisaEngineTests",
            dependencies: ["MatisaEngine", "MatisaCore"],
            path: "Tests/MatisaEngineTests"
        ),
        .testTarget(
            name: "MatisaCoreTests",
            dependencies: ["MatisaCore"],
            path: "Tests/MatisaCoreTests"
        ),
        .testTarget(
            name: "MatisaCLITests",
            dependencies: ["MatisaCLI", "MatisaCore"],
            path: "Tests/MatisaCLITests"
        )
    ]
)
