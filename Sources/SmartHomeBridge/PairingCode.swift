import AppKit
import CoreImage.CIFilterBuiltins

enum PairingCode {
    static func image(_ uri:String)->NSImage? {
        guard uri.range(of:"^X-HM://[0-9A-Z]{13}$",options:.regularExpression) != nil else { return nil }
        let filter=CIFilter.qrCodeGenerator()
        filter.message=Data(uri.utf8)
        filter.correctionLevel="M"
        guard let code=filter.outputImage else { return nil }
        // An explicit four-module quiet zone remains part of the image at any size.
        let extent=code.extent.insetBy(dx:-4,dy:-4)
        let backing=CIImage(color:.white).cropped(to:extent)
        let image=code.composited(over:backing).transformed(by:CGAffineTransform(scaleX:8,y:8))
        guard let cg=CIContext().createCGImage(image,from:image.extent) else { return nil }
        return NSImage(cgImage:cg,size:NSSize(width:image.extent.width,height:image.extent.height))
    }
}
