// swift-tools-version: 6.2
import PackageDescription
let package = Package(
    name:"SmartHomeBridge",
    platforms:[.macOS(.v15)],
    products:[.executable(name:"SmartHomeBridge",targets:["SmartHomeBridge"])],
    targets:[
        .executableTarget(name:"SmartHomeBridge",swiftSettings:[.defaultIsolation(MainActor.self),.enableUpcomingFeature("NonisolatedNonsendingByDefault")]),
        .testTarget(name:"SmartHomeBridgeTests",dependencies:["SmartHomeBridge"],path:"Tests/Swift")
    ]
)
