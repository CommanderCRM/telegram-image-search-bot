import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Only validated image bytes on stdin; no file paths or user-supplied commands.
func fail() -> Never { exit(2) }
let data = FileHandle.standardInput.readDataToEndOfFile()
guard !data.isEmpty, data.count <= 20 * 1024 * 1024,
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 2560,
        kCGImageSourceShouldCache: false,
      ] as CFDictionary) else { fail() }
let width = max(image.width, Int(ceil(Double(image.height) / 19.0)))
let height = max(image.height, Int(ceil(Double(image.width) / 19.0)))
guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fail() }
context.setFillColor(CGColor(gray: 1, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: width, height: height))
context.interpolationQuality = .high
context.draw(image, in: CGRect(x: (width-image.width)/2, y: (height-image.height)/2,
                               width: image.width, height: image.height))
guard let rendered = context.makeImage() else { fail() }
let output = NSMutableData()
guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { fail() }
CGImageDestinationAddImage(destination, rendered, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
guard CGImageDestinationFinalize(destination), output.length <= 10 * 1024 * 1024 else { fail() }
FileHandle.standardOutput.write(output as Data)
