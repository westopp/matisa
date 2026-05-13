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
        .executableTarget(
            name: "Matisa",
            path: "Sources/Matisa"
        ),
        .executableTarget(
            name: "MatisaEngine",
            path: "Sources/MatisaEngine"
        ),
        .testTarget(
            name: "MatisaTests",
            dependencies: ["Matisa"],
            path: "Tests/MatisaTests",
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "MatisaEngineTests",
            dependencies: ["MatisaEngine"],
            path: "Tests/MatisaEngineTests"
        )
    ]
)
