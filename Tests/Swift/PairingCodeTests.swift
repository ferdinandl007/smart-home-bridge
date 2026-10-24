import Testing
import Vision
import AppKit
@testable import SmartHomeBridge

@MainActor @Test func renderedHomeKitQRDecodesToOriginalURI() throws {
    let uri="X-HM://0024J31PGABCD"
    let image=try #require(PairingCode.image(uri))
    let cg=try #require(image.cgImage(forProposedRect:nil,context:nil,hints:nil))
    let request=VNDetectBarcodesRequest();request.symbologies=[.qr]
    try VNImageRequestHandler(cgImage:cg).perform([request])
    #expect(request.results?.first?.payloadStringValue == uri)
}
@MainActor @Test func invalidPairingPayloadIsNeverRendered() {
    #expect(PairingCode.image("") == nil)
    #expect(PairingCode.image("not a HomeKit setup URI") == nil)
}
