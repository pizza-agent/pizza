// Regenerate the committed installer artwork on macOS:
// swift scripts/generate-dmg-background.swift
// Finder supplies the draggable app and Applications icons; do not bake them in.
import AppKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let output = root.appendingPathComponent("apps/desktop/installer/background.png")
let width = 720
let height = 520
let scale = 2

let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: width * scale, pixelsHigh: height * scale,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
bitmap.size = NSSize(width: width, height: height)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

func color(_ hex: UInt32) -> NSColor {
    NSColor(
        srgbRed: CGFloat((hex >> 16) & 255) / 255,
        green: CGFloat((hex >> 8) & 255) / 255,
        blue: CGFloat(hex & 255) / 255, alpha: 1
    )
}

// Artwork coordinates use a top-left origin, matching Finder icon positions.
func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
    NSRect(x: x, y: CGFloat(height) - y - h, width: w, height: h)
}

let ink = color(0x302A24)
let muted = color(0x786E62)
let orange = color(0xE86927)

func text(
    _ value: String, x: CGFloat, y: CGFloat, size: CGFloat,
    weight: NSFont.Weight = .regular, tint: NSColor = ink,
    mono: Bool = false
) {
    let font = mono
        ? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
        : NSFont.systemFont(ofSize: size, weight: weight)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: tint]
    let string = value as NSString
    let measured = string.size(withAttributes: attributes)
    precondition(x + measured.width <= CGFloat(width) - 32, "Text overflows: \(value)")
    string.draw(at: NSPoint(x: x, y: CGFloat(height) - y - measured.height), withAttributes: attributes)
}

func line(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, tint: NSColor, thickness: CGFloat = 1) {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: x1, y: CGFloat(height) - y1))
    path.line(to: NSPoint(x: x2, y: CGFloat(height) - y2))
    path.lineWidth = thickness
    path.lineCapStyle = .round
    tint.setStroke()
    path.stroke()
}

color(0xFFFBF4).setFill()
NSBezierPath(rect: rect(0, 0, CGFloat(width), CGFloat(height))).fill()

text("01", x: 40, y: 46, size: 12, weight: .bold, tint: orange, mono: true)
text("Drag Pizza into Applications", x: 69, y: 40, size: 20, weight: .medium)
text("将 Pizza 拖入 Applications 文件夹完成安装。", x: 69, y: 72, size: 14, tint: muted)

// Align the arrow with the two real, draggable Finder icons.
line(324, 215, 396, 215, tint: orange, thickness: 3)
line(383, 202, 396, 215, tint: orange, thickness: 3)
line(383, 228, 396, 215, tint: orange, thickness: 3)

text("02", x: 40, y: 389, size: 12, weight: .bold, tint: orange, mono: true)
text("First install? Run this in Terminal after copying Pizza:", x: 69, y: 386, size: 16, weight: .medium)
text("若是首次安装，拖入 Pizza 后，请在「终端」手动执行：", x: 69, y: 414, size: 13, tint: muted)

color(0xF3EBDF).setFill()
NSBezierPath(roundedRect: rect(40, 450, 640, 46), xRadius: 10, yRadius: 10).fill()
text("xattr -cr /Applications/Pizza.app", x: 59, y: 462, size: 18, weight: .medium, mono: true)

NSGraphicsContext.restoreGraphicsState()
try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
try bitmap.representation(using: .png, properties: [:])!.write(to: output)
print("Generated \(output.path) (\(width) × \(height) points, @\(scale)x)")
