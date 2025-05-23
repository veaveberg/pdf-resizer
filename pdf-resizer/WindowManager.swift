import AppKit

class WindowManager {
    static let shared = WindowManager()

    static let fixedWidth: CGFloat = 480
    static let defaultInitialHeight: CGFloat = 600
    static let minHeight: CGFloat = 500

    static let frameAutosaveName = "PDFResizerMainWindow"

    // Base dimensions for the default frame, before centering.
    private static let baseDefaultSizedFrame = NSRect(x: 0, y: 0, width: fixedWidth, height: defaultInitialHeight)

    init() {
        // Calculate a centered version of the default frame for initial registration.
        var centeredDefaultFrame = WindowManager.baseDefaultSizedFrame
        if let screen = NSScreen.main { // Use main screen for default registration centering
            centeredDefaultFrame.origin.x = (screen.visibleFrame.width - centeredDefaultFrame.width) / 2 + screen.visibleFrame.minX
            centeredDefaultFrame.origin.y = (screen.visibleFrame.height - centeredDefaultFrame.height) / 2 + screen.visibleFrame.minY
        }

        let defaultFrameString = NSStringFromRect(centeredDefaultFrame)
        // Construct the actual key AppKit uses for storing the frame.
        let userDefaultsKey = "NSWindow Frame \(WindowManager.frameAutosaveName)"
        
        UserDefaults.standard.register(defaults: [userDefaultsKey: defaultFrameString])
    }
    
    func configureWindow(_ window: NSWindow) {
        // Standard window configuration
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName(WindowManager.frameAutosaveName)
        window.contentMinSize = NSSize(width: WindowManager.fixedWidth, height: WindowManager.minHeight)
        window.contentAspectRatio = NSSize(width: WindowManager.fixedWidth, height: WindowManager.minHeight)
        window.contentResizeIncrements = NSSize(width: 1, height: 1)
        
        // Disable standard window zoom (green) button
        window.standardWindowButton(.zoomButton)?.isEnabled = true
        
        // Set window to fixed width but variable height
        window.styleMask.remove(.resizable)
        window.styleMask.insert(.resizable)
        
        // If a user-moved frame exists for "PDFResizerMainWindow", it will be used.
        // Otherwise, we'll center the window.
        if !window.setFrameUsingName(WindowManager.frameAutosaveName) {
            window.center()
        }
    }
}
// The private extension NSRect for topLeft can be removed as lastWindowFrame is gone.