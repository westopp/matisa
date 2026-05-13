// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Matisa",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Matisa", targets: ["Matisa"]),
        .executable(name: "matisa-engine", targets: ["MatisaEngine"])
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
        )
    ]
)
