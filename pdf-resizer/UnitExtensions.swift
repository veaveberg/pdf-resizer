import CoreGraphics // For CGFloat

// Conversion utilities
extension CGFloat {
    // Convert points to millimeters (1 point = 0.352778 mm)
    var toMillimeters: CGFloat {
        return self * 0.352778
    }

    // Convert millimeters to points
    static func fromMillimeters(_ mm: CGFloat) -> CGFloat {
        return mm / 0.352778
    }
} 