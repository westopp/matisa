// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Matisa",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Matisa", targets: ["Matisa"])
    ],
    targets: [
        .executableTarget(
            name: "Matisa",
            path: "Sources/Matisa"
        ),
        .testTarget(
            name: "MatisaTests",
            dependencies: ["Matisa"],
            path: "Tests/MatisaTests",
            resources: [.copy("Fixtures")]
        )
    ]
)
