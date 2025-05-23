//
//  ContentView.swift
//  PDFResizer
//
//  Created by Sasha Berg on 5/23/25.
//

import SwiftUI
import PDFKit
import UniformTypeIdentifiers
import AppKit

// Define SaveStatus Enum here, outside ContentView struct but in the same file scope
enum SaveStatus {
    case idle, success, error, fileExistsWarning, permissionError
}

// Struct for items in the file conflict popover
struct ConflictingFileItem: Identifiable {
    let id = UUID()
    var fileName: String
    var shouldOverwrite: Bool // Default will be set based on isConflict
    var isConflict: Bool
    let adjusterID: SizeAdjuster.ID // ADDED: To link back to the SizeAdjuster
}

// Add the PageSelection enum
enum PageSelection {
    case singlePage, allPages
}

// CGFloat extensions, ResizeMode, PDFDocument, and SizeAdjuster are now in separate files.

// Helper extension for NSImage resizing (can be moved to a utility file later)
extension NSImage {
    func resized(to newSize: NSSize) -> NSImage {
        if self.size == newSize { return self } // Optimization
        let newImage = NSImage(size: newSize)
        newImage.lockFocus()
        self.draw(in: NSRect(origin: .zero, size: newSize),
                  from: NSRect(origin: .zero, size: self.size),
                  operation: .sourceOver,
                  fraction: 1.0)
        newImage.unlockFocus()
        return newImage
    }
}

struct FolderPopUpButton: NSViewRepresentable {
    @Binding var url: URL?
    private let iconSize = NSSize(width: 16, height: 16)

    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: false) // Standard pop-up
        button.autoenablesItems = false // Give us more control over item enabling
        // Target for menu item actions will be set on items themselves or funneled via coordinator
        buildMenu(for: button, context: context) // Initial build
        return button
    }

    func updateNSView(_ nsView: NSPopUpButton, context: Context) {
        buildMenu(for: nsView, context: context)
    }

    private func buildMenu(for button: NSPopUpButton, context: Context) {
        let menu = NSMenu()
        var addedURLs: Set<URL> = []

        func addMenuItem(for folderURL: URL, title overrideTitle: String? = nil, isCurrentSelection: Bool = false) {
            var isDir: ObjCBool = false
            guard !addedURLs.contains(folderURL.standardizedFileURL),
                  FileManager.default.fileExists(atPath: folderURL.path, isDirectory: &isDir),
                  isDir.boolValue else { return }

            let itemTitle = overrideTitle ?? folderURL.lastPathComponent
            let menuItem = NSMenuItem(title: itemTitle, action: #selector(Coordinator.selectFolderFromMenu(_:)), keyEquivalent: "")
            menuItem.target = context.coordinator // Explicitly set target for each item
            menuItem.representedObject = folderURL
            menuItem.isEnabled = true // Ensure item is enabled
            let icon = NSWorkspace.shared.icon(forFile: folderURL.path).resized(to: iconSize)
            menuItem.image = icon
            
            menu.addItem(menuItem)
            addedURLs.insert(folderURL.standardizedFileURL)
        }

        if let currentURL = url {
            addMenuItem(for: currentURL, isCurrentSelection: true)
        }

        if let currentURL = url {
            let parentURL = currentURL.deletingLastPathComponent()
            if parentURL.path != "/" && parentURL.path != currentURL.path && parentURL.pathComponents.count > 1 {
                addMenuItem(for: parentURL)
                let grandparentURL = parentURL.deletingLastPathComponent()
                if grandparentURL.path != "/" && grandparentURL.path != parentURL.path && grandparentURL.pathComponents.count > 1 {
                    addMenuItem(for: grandparentURL)
                }
            }
        }

        if let desktopURL = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first {
            addMenuItem(for: desktopURL, title: "Desktop")
        }
        
        if !menu.items.isEmpty && menu.items.last?.isSeparatorItem == false {
             menu.addItem(NSMenuItem.separator())
        }

        let otherItem = NSMenuItem(title: "Other…", action: #selector(Coordinator.chooseFolderPanel), keyEquivalent: "")
        otherItem.target = context.coordinator // Explicitly set target
        otherItem.isEnabled = true // Ensure item is enabled
        menu.addItem(otherItem)

        button.menu = menu
        
        if let currentURL = url,
           let itemToSelect = menu.items.first(where: { ($0.representedObject as? URL)?.standardizedFileURL == currentURL.standardizedFileURL }) {
            if button.selectedItem != itemToSelect { 
                 button.select(itemToSelect)
            }
        } 
        
        if let currentURL = url, let currentItemInMenu = menu.items.first(where: { ($0.representedObject as? URL)?.standardizedFileURL == currentURL.standardizedFileURL }) {
            button.setTitle(currentItemInMenu.title) 
        } else {
            button.setTitle("Choose Folder…")
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject {
        var parent: FolderPopUpButton

        init(_ popUpButtonView: FolderPopUpButton) {
            self.parent = popUpButtonView
        }

        @objc func selectFolderFromMenu(_ sender: NSMenuItem) {
            if let url = sender.representedObject as? URL {
                parent.url = url
            }
        }

        @objc func chooseFolderPanel(_ sender: Any?) { // Can be NSMenuItem or NSPopUpButton
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            
            // Store the previous URL in case user cancels
            let previousURL = parent.url
            
            // Flag to track if this is a popUpButton vs menu item activation
            let popUpButton = sender as? NSPopUpButton
            let previousSelectedItem = popUpButton?.selectedItem
            
            let result = panel.runModal()
            if result == .OK, let url = panel.url {
                // Only update if the user actually selected something
                parent.url = url
            } else {
                // If canceled or failed, revert back to previous URL and selection
                if popUpButton != nil, let previousItem = previousSelectedItem, previousItem.action == #selector(selectFolderFromMenu(_:)) {
                    // If triggered from popup directly, restore the previous selected item
                    DispatchQueue.main.async {
                        popUpButton?.select(previousItem)
                    }
                } else if let previousURL = previousURL {
                    // Just restore the previous URL value without trying to manipulate the popup directly
                    // This will trigger updateNSView to rebuild the menu with correct selection
                    
                    // Force a small change to trigger binding update if URL is the same
                    self.parent.url = nil
                    DispatchQueue.main.async {
                        self.parent.url = previousURL
                    }
                }
            }
        }
    }
}

struct PDFDropImageView: NSViewRepresentable {
    @Binding var selectedPDF: URL?
    var onSelect: (URL) -> Void

    func makeNSView(context: Context) -> NSImageView {
        let imageView = PDFDropImageNSView()
        imageView.delegate = context.coordinator
        imageView.image = nil
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.isEditable = false
        imageView.wantsLayer = true
        imageView.layer?.cornerRadius = 6
        imageView.layer?.masksToBounds = true
        imageView.toolTip = "Drag a PDF here or click to select"
        let clickGesture = NSClickGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.selectPDF))
        imageView.addGestureRecognizer(clickGesture)
        return imageView
    }

    func updateNSView(_ nsView: NSImageView, context: Context) {
        if let url = selectedPDF {
            nsView.image = NSWorkspace.shared.icon(forFile: url.path)
        } else {
            nsView.image = nil
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, NSGestureRecognizerDelegate, PDFDropImageNSViewDelegate {
        var parent: PDFDropImageView
        init(_ parent: PDFDropImageView) { self.parent = parent }

        @objc func selectPDF(_ sender: NSGestureRecognizer) {
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.pdf]
            panel.allowsMultipleSelection = false
            if panel.runModal() == .OK, let url = panel.url {
                parent.selectedPDF = url
                parent.onSelect(url)
            }
        }

        // Drag-and-drop delegate
        func didDropPDF(url: URL) {
            parent.selectedPDF = url
            parent.onSelect(url)
        }
    }
}

protocol PDFDropImageNSViewDelegate: AnyObject {
    func didDropPDF(url: URL)
}

class PDFDropImageNSView: NSImageView {
    weak var delegate: PDFDropImageNSViewDelegate?
    private var isDraggingOver = false {
        didSet { needsDisplay = true }
    }

    override func awakeFromNib() {
        super.awakeFromNib()
        registerForDraggedTypes([.fileURL])
    }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerForDraggedTypes([.fileURL])
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if getPDFURL(from: sender) != nil {
            isDraggingOver = true
            
            // Add haptic feedback when a valid PDF enters the drop area
            NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default)
            
            return .copy
        }
        return []
    }
    override func draggingExited(_ sender: NSDraggingInfo?) {
        isDraggingOver = false
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        return getPDFURL(from: sender) != nil
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        isDraggingOver = false
        guard let url = getPDFURL(from: sender) else { return false }
        
        // Add haptic feedback when the PDF is successfully dropped
        NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default)
        
        delegate?.didDropPDF(url: url)
        return true
    }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if isDraggingOver {
            NSColor.selectedControlColor.setStroke()
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 6, yRadius: 6)
            path.lineWidth = 3
            path.stroke()
        }
    }
    private func getPDFURL(from draggingInfo: NSDraggingInfo) -> URL? {
        let pasteboard = draggingInfo.draggingPasteboard
        guard let items = pasteboard.pasteboardItems else { return nil }
        for item in items {
            if let str = item.string(forType: .fileURL),
               let url = URL(string: str), url.pathExtension.lowercased() == "pdf" {
                return url
            }
        }
        return nil
    }
}

// Add this struct after PDFDropImageNSView
struct PDFThumbnailView: NSViewRepresentable {
    let url: URL
    var onDrop: (URL) -> Void
    var bleedTrimAmount: CGFloat = 0 // Trim amount parameter
    var currentResizeMode: ResizeMode = .fillSize // Parameter for current resize mode
    var targetSize: CGSize? = nil // Parameter for target dimensions
    var showFillPreview: Bool = false // Flag to control whether to show fill preview
    var currentPage: Int = 0 // Add current page parameter
    var totalPages: Int = 1 // Add total pages parameter
    var onPageChange: ((Int) -> Void)? // Add callback for page changes
    
    class Coordinator: NSObject {
        var parent: PDFThumbnailView
        var isDraggingOver = false {
            didSet {
                if let imageView = imageView {
                    imageView.layer?.backgroundColor = isDraggingOver ? 
                        NSColor.black.withAlphaComponent(0.1).cgColor : 
                        NSColor.clear.cgColor
                    imageView.layer?.borderWidth = isDraggingOver ? 2 : 0
                    imageView.layer?.borderColor = NSColor.systemBlue.cgColor
                }
            }
        }
        weak var imageView: NSImageView?
        
        init(_ parent: PDFThumbnailView) {
            self.parent = parent
            super.init()
        }
    }
    
    func makeCoordinator() -> Coordinator {
        return Coordinator(self)
    }
    
    func makeNSView(context: Context) -> NSImageView {
        let imageView = NSImageView()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.wantsLayer = true
        imageView.layer?.cornerRadius = 8
        context.coordinator.imageView = imageView
        
        // Setup drag and drop handling
        let dropHandler = DroppableView(onDrop: { url in
            context.coordinator.isDraggingOver = false
            self.onDrop(url)
        }, coordinator: context.coordinator, pdfParent: self)
        imageView.addSubview(dropHandler)
        dropHandler.frame = imageView.bounds
        dropHandler.autoresizingMask = [.width, .height]
        
        // Use the enhanced async thumbnail generator method with all parameters
        ContentView.shared.generatePDFThumbnail(
            for: url,
            page: currentPage,
            bleedTrimAmount: bleedTrimAmount,
            resizeMode: currentResizeMode,
            targetSize: targetSize,
            showFillPreview: showFillPreview
        ) { thumbnail in
            imageView.image = thumbnail
        }
        
        return imageView
    }
    
    func updateNSView(_ imageView: NSImageView, context: Context) {
        // Update thumbnail using the async method with all parameters
        ContentView.shared.generatePDFThumbnail(
            for: url,
            page: currentPage,
            bleedTrimAmount: bleedTrimAmount,
            resizeMode: currentResizeMode,
            targetSize: targetSize,
            showFillPreview: showFillPreview
        ) { thumbnail in
            imageView.image = thumbnail
        }
    }
}

// Helper class to handle drag and drop
class DroppableView: NSView {
    weak var coordinator: PDFThumbnailView.Coordinator?
    var onDrop: (URL) -> Void
    var pdfParent: PDFThumbnailView? // Add reference to parent
    
    init(onDrop: @escaping (URL) -> Void, coordinator: PDFThumbnailView.Coordinator, pdfParent: PDFThumbnailView? = nil) {
        self.onDrop = onDrop
        self.coordinator = coordinator
        self.pdfParent = pdfParent
        super.init(frame: NSRect(x: 0, y: 0, width: 250, height: 200))
        self.registerForDraggedTypes([.fileURL])
        self.wantsLayer = true
        self.layer?.backgroundColor = .clear
        
        // Fix for deprecated API and read-only property
        // Use allowedTouchTypes instead of acceptsTouchEvents
        if #available(macOS 10.12.2, *) {
            // Fix: don't use rawValue, pass the enum value directly
            self.allowedTouchTypes = NSTouch.TouchTypeMask.direct
        }
        
        // Make view accept keyboard - use proper way instead of direct assignment
        // which isn't possible since canBecomeKeyView is read-only
        self.nextResponder = self.window?.firstResponder
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    override func mouseDown(with event: NSEvent) {
        // Get the parent thumbnail view to access its pagination parameters
        guard let parent = pdfParent, parent.totalPages > 1 else {
            super.mouseDown(with: event)
            return
        }

        // Define pagination control area
        let controlHeight: CGFloat = 26
        let controlWidth: CGFloat = 100
        let controlY: CGFloat = 8
        let controlX: CGFloat = (bounds.width - controlWidth) / 2
        let controlRect = NSRect(x: controlX, y: controlY, width: controlWidth, height: controlHeight)
        
        // Check if the click is within the pagination control
        let location = event.locationInWindow
        let localPoint = convert(location, from: nil)
        
        if controlRect.contains(localPoint) {
            // Simple approach: divide control at midpoint as before
            let midX = controlRect.midX
            
            if localPoint.x < midX && parent.currentPage > 0 {
                // Click on left side - go to previous page
                parent.onPageChange?(parent.currentPage - 1)
            } else if localPoint.x >= midX && parent.currentPage < parent.totalPages - 1 {
                // Click on right side - go to next page
                parent.onPageChange?(parent.currentPage + 1)
            }
            return
        }
        
        super.mouseDown(with: event)
    }
    
    override func keyDown(with event: NSEvent) {
        guard let parent = pdfParent, parent.totalPages > 1 else {
            super.keyDown(with: event)
            return
        }
        
        let keyCode = event.keyCode
        switch keyCode {
        case 123: // Left arrow
            if parent.currentPage > 0 {
                parent.onPageChange?(parent.currentPage - 1)
            }
        case 124: // Right arrow
            if parent.currentPage < parent.totalPages - 1 {
                parent.onPageChange?(parent.currentPage + 1)
            }
        default:
            super.keyDown(with: event)
        }
    }
    
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        coordinator?.isDraggingOver = true
        
        // Add haptic feedback when a file enters the drop area
        NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default)
        
        return .copy
    }
    
    override func draggingExited(_ sender: NSDraggingInfo?) {
        coordinator?.isDraggingOver = false
    }
    
    override func draggingEnded(_ sender: NSDraggingInfo) {
        coordinator?.isDraggingOver = false
    }
    
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let fileURL = sender.draggingPasteboard.propertyList(forType: .fileURL) as? String,
              let url = URL(string: fileURL),
              url.pathExtension.lowercased() == "pdf" else { return false }
        
        // Add haptic feedback when a PDF is successfully dropped
        NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default)
        
        onDrop(url)
        return true
    }
}

// Make PDFThumbnailView conform to Equatable
extension PDFThumbnailView: Equatable {
    static func == (lhs: PDFThumbnailView, rhs: PDFThumbnailView) -> Bool {
        return lhs.url == rhs.url
    }
}

// Add custom NSTextView for token formatting
class TokenFormattingTextView: NSTextView {
    override func didChangeText() {
        super.didChangeText()
        formatTokens()
    }
    
    // Make insertText accessible for token insertion
    override func insertText(_ string: Any, replacementRange: NSRange) {
        super.insertText(string, replacementRange: replacementRange)
        // Make sure we format after inserting
        formatTokens()
    }
    
    private func formatTokens() {
        guard let storage = textStorage else { return }
        let fullRange = NSRange(location: 0, length: storage.length)
        
        // Save cursor position
        let cursorPosition = selectedRange()
        
        // Remove existing attributes
        storage.removeAttribute(.foregroundColor, range: fullRange)
        storage.removeAttribute(.font, range: fullRange)
        
        // Apply base font
        storage.addAttribute(.font, value: NSFont.systemFont(ofSize: NSFont.systemFontSize), range: fullRange)
        
        // Format tokens
        let tokens = ["*YYMMDD*", "*size*"]
        let text = storage.string
        
        for token in tokens {
            var searchRange = NSRange(location: 0, length: text.count)
            while searchRange.location < text.count {
                let foundRange = (text as NSString).range(of: token, options: [], range: searchRange)
                if foundRange.location != NSNotFound {
                    storage.addAttribute(.foregroundColor, value: NSColor.controlAccentColor, range: foundRange)
                    storage.addAttribute(.font, value: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize), range: foundRange)
                    searchRange.location = foundRange.location + foundRange.length
                    searchRange.length = text.count - searchRange.location
                } else {
                    break
                }
            }
        }
        
        // Restore cursor position
        setSelectedRange(cursorPosition)
    }
}

// Add custom NSTextFieldCell for token formatting
class TokenFormattingTextFieldCell: NSTextFieldCell {
    override func drawInterior(withFrame cellFrame: NSRect, in controlView: NSView) {
        // Only draw formatted text when not editing
        if (controlView as? NSTextField)?.currentEditor() == nil {
            guard let attributedString = formatTokens(stringValue) else {
                super.drawInterior(withFrame: cellFrame, in: controlView)
                return
            }
            // Set the base attributes for the entire string
            let baseAttributes: [NSAttributedString.Key: Any] = [
                .font: font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize),
                .foregroundColor: textColor ?? NSColor.textColor
            ]
            attributedString.addAttributes(baseAttributes, range: NSRange(location: 0, length: attributedString.length))
            
            var adjustedRect = self.titleRect(forBounds: cellFrame)
            // MODIFIED: Final fine-tuning of horizontal adjustment.
            adjustedRect.origin.x += 11.0 
            adjustedRect.size.width -= 22.0 // Adjust width to account for bilateral padding assumption

            attributedString.draw(in: adjustedRect)
        } else {
            super.drawInterior(withFrame: cellFrame, in: controlView)
        }
    }
    
    private func formatTokens(_ text: String) -> NSMutableAttributedString? {
        let attributedString = NSMutableAttributedString(string: text)
        let tokens = ["*YYMMDD*", "*size*"]
        
        // Format tokens with background highlight
        for token in tokens {
            var searchRange = NSRange(location: 0, length: text.count)
            while true {
                let range = (text as NSString).range(of: token, options: [], range: searchRange)
                if range.location == NSNotFound { break }
                
                attributedString.addAttributes([
                    .backgroundColor: NSColor.systemYellow.withAlphaComponent(0.3)
                ], range: range)
                
                searchRange.location = range.location + range.length
                searchRange.length = text.count - searchRange.location
            }
        }
        
        return attributedString
    }
}

// Add custom TokenFormattingTextField for token formatting
class TokenFormattingTextField: NSTextField {
    private var isBecomingFirstResponder = false
    
    override class var cellClass: AnyClass? {
        get { TokenFormattingTextFieldCell.self }
        set { }
    }
    
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        self.textColor = .textColor
    }
    
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        self.textColor = .textColor
    }
    
    // Override to improve first responder handling
    override func becomeFirstResponder() -> Bool {
        // Prevent recursive calls which can cause freezes
        if isBecomingFirstResponder { return true }
        
        isBecomingFirstResponder = true
        defer { isBecomingFirstResponder = false }
        
        let result = super.becomeFirstResponder()
        return result
    }
}

// Add NSViewRepresentable for the custom text field
struct TokenFormattingTextFieldRepresentable: NSViewRepresentable {
    @Binding var text: String
    let isEnabled: Bool
    var onFocusChangeCoordinator: ((Bool) -> Void)?
    

    
    // Add a binding for the text field reference
    @Binding var textFieldReference: NSTextField?
    
    // Initializer that makes the binding optional
    init(text: Binding<String>, 
         isEnabled: Bool, 
         onFocusChangeCoordinator: ((Bool) -> Void)? = nil, 
         textFieldReference: Binding<NSTextField?> = .constant(nil)) {
        self._text = text
        self.isEnabled = isEnabled
        self.onFocusChangeCoordinator = onFocusChangeCoordinator
        self._textFieldReference = textFieldReference
    }
    
    func makeNSView(context: Context) -> TokenFormattingTextField {
        let textField = TokenFormattingTextField()
        textField.isEnabled = isEnabled
        textField.isEditable = true
        textField.isSelectable = true
        textField.delegate = context.coordinator
        textField.bezelStyle = .roundedBezel
        textField.identifier = NSUserInterfaceItemIdentifier("TokenFormattingTextField")
        
        // Store the reference to the text field
        DispatchQueue.main.async {
            textFieldReference = textField
        }
        
        // Enable field editor early by simulating user interaction - but do it safely
        DispatchQueue.main.async { [weak textField] in
            if let textField = textField, let window = textField.window {
                // Only activate if no other field has focus
                if !(window.firstResponder is NSTextView) && textField.currentEditor() == nil {
                    _ = textField.becomeFirstResponder()
                }
            }
        }
        
        return textField
    }
    
    func updateNSView(_ nsView: TokenFormattingTextField, context: Context) {
        if nsView.stringValue != text {
            nsView.stringValue = text
        }
        nsView.isEnabled = isEnabled
        nsView.isEditable = true
        nsView.isSelectable = true
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: TokenFormattingTextFieldRepresentable
        
        init(_ parent: TokenFormattingTextFieldRepresentable) {
            self.parent = parent
        }
        
        func controlTextDidChange(_ obj: Notification) {
            if let textField = obj.object as? NSTextField {
                parent.text = textField.stringValue
                

            }
        }

        // More aggressive focus tracking
        func controlTextDidBeginEditing(_ obj: Notification) {
            print("controlTextDidBeginEditing")
            parent.onFocusChangeCoordinator?(true)
            

        }

        // Enhance controlTextDidEndEditing in the Coordinator class to handle trim field better
        func controlTextDidEndEditing(_ obj: Notification) {
            if let textField = obj.object as? NSTextField {
                // Add debugging for trim field
                let isTrimField = textField.tag == 1001
                if isTrimField {
                    print("*** Trim field ended editing. Final value: \(textField.stringValue)")
                    
                    // For trim field, check if it's due to a window change or app deactivation
                    if let endReason = obj.userInfo?["NSTextMovement"] as? Int {
                        // Check if this is due to clicking elsewhere (not tab/return)
                        if endReason == NSTextMovement.other.rawValue {
                            print("*** Trim field lost focus due to clicking elsewhere")
                            
                            // Special handling to maintain app's focus state even though the field lost focus
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                                // Try to refocus the field
                                if let window = textField.window {
                                    window.makeFirstResponder(textField)
                                }
                            }
                        }
                    }
                }
                
                // We don't need a commit call here - just handle the focus change notification
                parent.onFocusChangeCoordinator?(false)
            }
        }
        
        // Get notified about selection changes
        @objc func textViewDidChangeSelection(_ notification: Notification) {
            print("Selection changed")
            parent.onFocusChangeCoordinator?(true)
        }
    }
}

// Update FileNameEditor to use the new text field
struct FileNameEditor: View {
    @Binding var fileName: String
    @Binding var originalFileName: String
    @FocusState private var isFocused: Bool
    let disabled: Bool
    let onFocusChange: (Bool) -> Void
    
    // Add a state to hold a reference to the text field
    @State var textField: NSTextField?
    
    // Function to insert text at cursor position that can be called from outside
    func insertTextAtCursor(_ text: String) {
        print("insertTextAtCursor called with text: \(text)")
        
        // Get the current window and first responder
        guard let window = NSApplication.shared.keyWindow else {
            print("No key window found")
            fileName += text
            return
        }
        
        // Make sure our text field is focused before inserting
        if let textField = textField {
            // Force focus
            window.makeFirstResponder(textField)
            
            // Try to get current editor if it exists
            if let fieldEditor = textField.currentEditor() as? NSTextView {
                // Get selection range or cursor position
                let selectedRange = fieldEditor.selectedRange()
                
                if selectedRange.length > 0 {
                    // Replace selected text
                    fieldEditor.replaceCharacters(in: selectedRange, with: text)
                } else {
                    // Insert at cursor position
                    fieldEditor.insertText(text, replacementRange: selectedRange)
                }
                
                // Update our string from field editor
                self.fileName = fieldEditor.string
            } else {
                // No field editor yet, append to the end as a fallback
                fileName += text
                
                // Try to create field editor and set cursor
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    if let newEditor = textField.currentEditor() as? NSTextView {
                        newEditor.setSelectedRange(NSRange(location: self.fileName.count, length: 0))
                    }
                }
            }
        } else {
            // Fallback to direct insertion
            fileName += text
        }
    }
    
    var body: some View {
        HStack(spacing: 4) {
            TokenFormattingTextFieldRepresentable(
                text: $fileName,
                isEnabled: !disabled,
                onFocusChangeCoordinator: { focused in
                    print("Focus changed to: \(focused)")
                    onFocusChange(focused)
                    isFocused = focused
                                 },
                 textFieldReference: $textField
            )
            .focused($isFocused)
            .onChange(of: isFocused) { oldValue, newValue in
                print("isFocused changed from \(oldValue) to \(newValue)")
            }

            if fileName != originalFileName && !disabled {
                Button {
                    fileName = originalFileName
                    
                    // After restoring filename, ensure focus state is maintained
                    if let window = NSApplication.shared.keyWindow,
                       let textField = self.textField {
                        DispatchQueue.main.async {
                            window.makeFirstResponder(textField)
                        }
                    }
                } label: {
                    Image(systemName: "arrow.counterclockwise.circle.fill")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .help("Restore original filename")
            }
        }
    }
}

// Fix TokensRow to not rely on FileNameEditor type
struct TokensRow: View {
    @Binding var outputBaseName: String
    @State private var wiggleSizeButton: Bool = false
    @State private var wiggleDateButton: Bool = false
    @State private var showingYYMMDDCopiedTooltip: Bool = false
    @State private var showingSizeCopiedTooltip: Bool = false
    
    // For our new version, we'll directly check for a text field focus
    let isFocused: Bool
    
    // Remove reference to FileNameEditor and use optional closure instead
    var insertTextAtCursor: ((String) -> Void)?
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Button row
            HStack(spacing: 8) {
                // Autoreplace buttons
                TokenButtonView(label: "Autoreplace Size", action: {
                    if ContentView.stringContainsSizePattern(outputBaseName) {
                        outputBaseName = ContentView.replaceSizePattern(in: outputBaseName, with: "*size*")
                    } else {
                        wiggleSizeButton = true 
                    }
                }, triggerWiggle: $wiggleSizeButton)
                
                TokenButtonView(label: "Autoreplace Date", action: {
                    if ContentView.stringContainsDatePattern(outputBaseName) {
                        outputBaseName = ContentView.replaceFirstDatePattern(in: outputBaseName, with: "*YYMMDD*")
                    } else {
                        wiggleDateButton = true 
                    }
                }, triggerWiggle: $wiggleDateButton)
                
                Spacer()
            }
            
            // Tokens hint on second line with fixed height to prevent layout shifts
            HStack(spacing: 4) {
                Text(verbatim: "Dynamic date — ")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize()
                
                // YYMMDD token with tooltip as overlay
                Text(verbatim: "*YYMMDD*")
                    .font(.caption.bold())
                    .foregroundColor(.secondary)
                    .italic(false)
                    .padding(.horizontal, 2)
                    .padding(.vertical, 1)
                    .background(Color.gray.opacity(0.1))
                    .cornerRadius(3)
                    .fixedSize()
                    .overlay(
                        showingYYMMDDCopiedTooltip ? 
                            Image(systemName: "clipboard.fill")
                                .font(.caption2)
                                .foregroundColor(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 4)
                                .background(Color.accentColor)
                                .cornerRadius(4)
                                .offset(y: -25)
                                .transition(.opacity)
                                .zIndex(1)
                            : nil
                    )
                    .onTapGesture {
                        // Copy to pasteboard
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString("*YYMMDD*", forType: .string)
                        
                        // Show tooltip
                        showingYYMMDDCopiedTooltip = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            showingYYMMDDCopiedTooltip = false
                        }
                        
                        // Remove insertion at cursor - we only want to copy to clipboard
                    }
                
                Text(verbatim: ", dynamic size — ")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize()
                
                // Size token with tooltip as overlay
                Text(verbatim: "*size*")
                    .font(.caption.bold())
                    .foregroundColor(.secondary)
                    .italic(false)
                    .padding(.horizontal, 2)
                    .padding(.vertical, 1)
                    .background(Color.gray.opacity(0.1))
                    .cornerRadius(3)
                    .fixedSize()
                    .overlay(
                        showingSizeCopiedTooltip ? 
                            Image(systemName: "clipboard.fill")
                                .font(.caption2)
                                .foregroundColor(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 4)
                                .background(Color.accentColor)
                                .cornerRadius(4)
                                .offset(y: -25)
                                .transition(.opacity)
                                .zIndex(1)
                            : nil
                    )
                    .onTapGesture {
                        // Copy to pasteboard
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString("*size*", forType: .string)
                        
                        // Show tooltip
                        showingSizeCopiedTooltip = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            showingSizeCopiedTooltip = false
                        }
                        
                        // Remove insertion at cursor - we only want to copy to clipboard
                    }
            }
            .frame(height: 30) // Fixed height to prevent layout shifts
            .animation(.easeInOut(duration: 0.2), value: showingYYMMDDCopiedTooltip)
            .animation(.easeInOut(duration: 0.2), value: showingSizeCopiedTooltip)
        }
        .font(.caption)
    }
}

// First, fix the StepperNSTextField class to better handle focus
class StepperNSTextField: NSTextField {
    var onStep: ((_ delta: CGFloat, _ field: StepperNSTextField) -> Void)?
    // Add a flag to prevent recursive calls
    private var isBecomingFirstResponder = false
    // Add a flag to prevent focus loss during edits
    var isInitialEdit = true
    
    // Add a lock to prevent concurrent access issues
    private let focusLock = NSLock()
    
    override var acceptsFirstResponder: Bool {
        return true
    }
    
    // Override to improve first responder handling, but avoid recursion
    override func becomeFirstResponder() -> Bool {
        // Use a lock to prevent concurrent access issues
        focusLock.lock()
        defer { focusLock.unlock() }
        
        // Prevent recursive calls which can cause freezes
        if isBecomingFirstResponder { return true }
        
        isBecomingFirstResponder = true
        defer { isBecomingFirstResponder = false }
        
        let result = super.becomeFirstResponder()
        
        // Only try to force field editor if we actually became first responder
        if result && currentEditor() == nil && window != nil {
            // Request field editor without forcing creation
            // This prevents potential deadlocks with other UI components
            DispatchQueue.main.async { [weak self] in
                guard let self = self, let window = self.window else { return }
                if self.currentEditor() == nil && window.firstResponder == self {
                    // Only force field editor if we're still first responder after async
                    _ = window.fieldEditor(true, for: self)
                }
            }
        }
        
        return result
    }
    
    // Improve click handling - use async to avoid focus conflicts
    override func mouseDown(with event: NSEvent) {
        super.mouseDown(with: event)
        
        // Defer first responder handling to avoid conflicts with existing UI operations
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let window = self.window else { return }
            if window.firstResponder != self && !self.isBecomingFirstResponder {
                window.makeFirstResponder(self)
            }
        }
    }
    
    // Replace the StepperNSTextField textDidChange method to improve focus handling
    override func textDidChange(_ notification: Notification) {
        super.textDidChange(notification)
        // We need to preserve focus especially for the trim field (tag 1001)
        if tag == 1001 {
            print("*** Trim field textDidChange - preserving focus")
        }
        isInitialEdit = false
    }
}

// First fix the StepperNSTextField class to handle focus better

// Also enhance StepperTextField to specifically address the trim field issues:
struct StepperTextField: NSViewRepresentable {
    @Binding var value: CGFloat
    let formatter: NumberFormatter
    let minValue: CGFloat?
    let maxValue: CGFloat?
    var onCommit: (() -> Void)? = nil

    // Add makeCoordinator if it's missing
    func makeCoordinator() -> Coordinator {
        return Coordinator(self)
    }
    
    func makeNSView(context: Context) -> StepperNSTextField {
        let textField = StepperNSTextField()
        textField.delegate = context.coordinator
        // Assign the initial formatter. Coordinator will grab it.
        textField.formatter = formatter 
        textField.isEditable = true
        textField.isSelectable = true
        textField.focusRingType = .default
        textField.bezelStyle = .roundedBezel
        textField.stringValue = formatter.string(from: NSNumber(value: Double(value))) ?? ""
        textField.wantsLayer = true
        textField.layer?.cornerRadius = 6
        textField.layer?.masksToBounds = true
        textField.layer?.borderWidth = 0
        textField.layer?.backgroundColor = NSColor.clear.cgColor
        // Align text to the right and remove extra padding
        textField.alignment = .right
        textField.cell?.usesSingleLineMode = true
        
        // Special handling to avoid focus-related deadlocks
        if value == 0 { // This is likely the bleed trim field if value is 0
            print("Creating trim field with value: \(value)")
            // Add special tag to identify the trim field
            textField.tag = 1001
        }
        
        textField.onStep = { delta, fieldInstance in
            // We'll perform all calculations on the main thread to avoid priority inversion
            // This is called infrequently enough that it won't impact UI responsiveness
            DispatchQueue.main.async {
                var newValue = self.value + delta
                if let minValue = self.minValue { newValue = max(newValue, minValue) }
                if let maxValue = self.maxValue { newValue = min(newValue, maxValue) }
                
                if self.value != newValue { // Only update model if value actually changed
                    self.value = newValue
                }
                
                // Now update the text field on the same thread (main)
                let newStringValue = context.coordinator.originalFormatter?.string(from: NSNumber(value: Double(self.value))) ?? ""
                fieldInstance.stringValue = newStringValue
                fieldInstance.selectText(nil)
            }
        }
        return textField
    }

    func updateNSView(_ nsView: StepperNSTextField, context: Context) {
        // For trim field, we need to be extra careful about when we update the value
        let isTrimField = nsView.tag == 1001
        
        // Debug log for trim field
        if isTrimField {
            print("Update trim field: editor=\(nsView.currentEditor() != nil), value=\(value)")
        }
        
        // Only update the value if:
        // 1. The field doesn't have focus (no editor) OR
        // 2. It's the trim field AND there's a significant value difference
        let hasEditor = nsView.currentEditor() != nil
        let shouldUpdate = !hasEditor || (isTrimField && abs(Double(nsView.doubleValue) - Double(value)) > 0.5)
        
        if shouldUpdate {
            let formattedModelString = context.coordinator.originalFormatter?.string(from: NSNumber(value: Double(value))) ?? ""
            if nsView.stringValue != formattedModelString {
                // For the trim field, we need to be very careful updating during editing
                if isTrimField && hasEditor {
                    print("*** Trim field value updated during editing: \(nsView.stringValue) -> \(formattedModelString)")
                }
                nsView.stringValue = formattedModelString
            }
        }

        // Make sure onStep closure is always updated
        nsView.onStep = { delta, fieldInstance in
            // We'll perform all calculations on the main thread to avoid priority inversion
            // This is called infrequently enough that it won't impact UI responsiveness
            DispatchQueue.main.async {
                var newValue = self.value + delta
                if let minValue = self.minValue { newValue = max(newValue, minValue) }
                if let maxValue = self.maxValue { newValue = min(newValue, maxValue) }

                // Log trim field updates
                if isTrimField {
                    print("*** Trim field step: \(self.value) -> \(newValue)")
                }

                if self.value != newValue { // Only update model if value actually changed
                    self.value = newValue
                }
                
                // Update text field on the same thread
                let newStringValue = context.coordinator.originalFormatter?.string(from: NSNumber(value: Double(self.value))) ?? ""
                fieldInstance.stringValue = newStringValue
                fieldInstance.selectText(nil)
            }
        }
    }

    class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: StepperTextField
        var originalFormatter: NumberFormatter? // MODIFIED: Removed private for internal access

        init(_ parent: StepperTextField) {
            self.parent = parent
            // Capture the parent's formatter when the coordinator is created.
            self.originalFormatter = parent.formatter
        }

        func controlTextDidBeginEditing(_ obj: Notification) {
            guard let textField = obj.object as? NSTextField else { return }
            let isTrimField = textField.tag == 1001
            
            if isTrimField {
                print("*** Trim field began editing: \(textField.stringValue)")
            }
            
            // Remove formatter to allow free typing
            textField.formatter = nil
            
            // Explicitly reset the initial edit flag
            if let stepperField = textField as? StepperNSTextField {
                stepperField.isInitialEdit = true
            }
        }

        func controlTextDidChange(_ obj: Notification) {
            guard let textField = obj.object as? NSTextField else { return }
            let currentText = textField.stringValue
            
            // For the first edit or if it's the trim field, we're extra careful
            if let stepperField = textField as? StepperNSTextField, stepperField.isInitialEdit {
                print("*** Initial edit, skipping model update to preserve focus")
                return
            }
            
            // Note: This is a trim field if tag is 1001
            let isTrimField = textField.tag == 1001
            if isTrimField {
                print("*** Trim field text changed to: \(currentText)")
            }
            
            // Lenient parsing for live model update
            // Replace comma with period for locales that use comma as decimal separator
            let parsableText = currentText.replacingOccurrences(of: originalFormatter?.decimalSeparator ?? ",", with: ".")
            
            if let typedValue = Double(parsableText) {
                let newValue = CGFloat(typedValue)
                // We could apply min/max here for immediate clamping, or defer to commit
                // For now, let's just update the value if it parse
                if parent.value != newValue { // Avoid redundant updates
                    parent.value = newValue
                }
            } else if currentText.isEmpty {
                 // If field is empty, you might want to set model to 0 or a minVal
                 // For now, if parent.value is already 0, no change. Or parent.value = 0
                 if parent.value != 0 { parent.value = 0 } // Example: reset to 0 if empty
            }
            // If not parseable as Double and not empty, parent.value remains unchanged.
            // The text field shows what the user typed.
        }

        @objc func commit(_ sender: NSTextField) {
            sender.formatter = originalFormatter // Restore strict formatter for final parsing and display

            if let number = originalFormatter?.number(from: sender.stringValue) {
                var newValue = CGFloat(truncating: number)
                if let minValue = parent.minValue { newValue = max(newValue, minValue) }
                if let maxValue = parent.maxValue { newValue = min(newValue, maxValue) }
                parent.value = newValue
            } else {
                // If parsing fails with strict formatter, revert to the current model value
                // (which might be the last successfully parsed value from controlTextDidChange or initial value)
            }
            
            // Ensure the text field displays the strictly formatted final model value
            sender.stringValue = originalFormatter?.string(from: NSNumber(value: Double(parent.value))) ?? ""
            
            // Fire commit callback if provided
            parent.onCommit?()
        }

        func controlTextDidEndEditing(_ obj: Notification) {
            if let textField = obj.object as? NSTextField {
                // Add debugging for trim field
                let isTrimField = textField.tag == 1001
                if isTrimField {
                    print("*** Trim field ended editing. Final value: \(textField.stringValue)")
                }
                
                commit(textField)
            }
        }
        
        // ... existing code for key commands ...

        // Handle key commands with Adobe-style rounding
        func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            print("StepperTextField.Coordinator: doCommandBySelector - \(NSStringFromSelector(commandSelector))") // DEBUG PRINT
            
            var isUp: Bool = false 
            var shiftPressed: Bool = false
            var shouldHandleCommand: Bool = false
            
            // Detect which arrow key is pressed and if shift is held
            if let event = NSApp.currentEvent, event.type == .keyDown {
                shiftPressed = event.modifierFlags.contains(.shift)
            }

            // Determine if it's an arrow command we should handle
            if commandSelector == #selector(NSTextView.moveUp(_:)) {
                isUp = true
                shouldHandleCommand = true
            } else if commandSelector == #selector(NSTextView.moveDown(_:)) {
                isUp = false
                shouldHandleCommand = true
            } else if commandSelector == #selector(NSTextView.moveUpAndModifySelection(_:)) {
                isUp = true
                shouldHandleCommand = true
                shiftPressed = true // Ensure shift is recognized for these commands
            } else if commandSelector == #selector(NSTextView.moveDownAndModifySelection(_:)) {
                isUp = false
                shouldHandleCommand = true
                shiftPressed = true // Ensure shift is recognized for these commands
            }

            if shouldHandleCommand {
                // Get the current value
                let currentValue = parent.value
                var newValue: CGFloat
                
                if shiftPressed {
                    // Shift+Arrow: Round to nearest 10
                    let remainder = currentValue.truncatingRemainder(dividingBy: 10)
                    
                    if isUp {
                        // Round up to next multiple of 10
                        newValue = currentValue - remainder + (remainder > 0 ? 10 : 0)
                        // If already at a multiple of 10, go to the next one
                        if remainder == 0 {
                            newValue += 10
                        }
                    } else {
                        // Round down to previous multiple of 10
                        newValue = currentValue - remainder
                        // If already at a multiple of 10, go to the previous one
                        if remainder == 0 {
                            newValue -= 10
                        }
                    }
                } else {
                    // Regular Arrow: Round to nearest whole number
                    let fractionalPart = currentValue - floor(currentValue)
                    
                    if isUp {
                        // Round up to next whole number
                        if fractionalPart > 0 {
                            newValue = ceil(currentValue)
                        } else {
                            // If already at a whole number, increment by 1
                            newValue = currentValue + 1
                        }
                    } else {
                        // Round down to previous whole number
                        if fractionalPart > 0 {
                            newValue = floor(currentValue)
                        } else {
                            // If already at a whole number, decrement by 1
                            newValue = currentValue - 1
                        }
                    }
                }
                
                // Apply min/max constraints
                if let minValue = parent.minValue { newValue = max(newValue, minValue) }
                if let maxValue = parent.maxValue { newValue = min(newValue, maxValue) }
                
                if parent.value != newValue { // Only update if actually changed
                    parent.value = newValue
                }
                
                // Update the field editor's text and select it
                let newStringValue = originalFormatter?.string(from: NSNumber(value: Double(parent.value))) ?? ""
                textView.string = newStringValue
                textView.selectAll(nil)
                
                return true // Command was handled
            }
            
            return false // Command not handled, let default behavior proceed
        }
    }
}

// Add this enum at the top of ContentView
enum FieldFocus: Hashable {
    case width(UUID)
    case height(UUID)
    case fileName
    case bleedTrim
}
// SizeAdjusterRow has been moved to its own file

struct ContentView: View {
    // Create a shared instance that can be accessed from elsewhere
    static let shared = ContentView()
    
    @State private var selectedPDF: URL?
    @State private var isFilePickerPresented = false
    @State private var sizeAdjusters: [SizeAdjuster] = [SizeAdjuster()]
    @State private var isProcessing = false
    @State private var saveStatus: SaveStatus = .idle
    @State private var showFileExistsPopover: Bool = false
    @State private var showPermissionErrorPopover: Bool = false
    @State private var filesToProcess: [ConflictingFileItem] = [] // Renamed for clarity
    @State private var currentSize: CGSize?
    @State private var saveFolder: URL?
    @State private var outputBaseName: String = ""
    @State private var useSubfolder: Bool = false
    @State private var subfolderName: String = "PDF"
    @State private var bleedTrimAmount: CGFloat = 0 // New state for bleed trimming
    @FocusState private var focusedField: FieldFocus?
    @State private var currentWindow: NSWindow?
    @State private var iconScaleEffect: CGFloat = 1.0 // For bounce animation
    @State private var originalOutputBaseName: String = "" // ADDED: To store the original filename for restore
    
    // Add state for current page and total pages
    @State private var currentPage: Int = 0
    @State private var totalPages: Int = 1
    @State private var pdfDocument: PDFKit.PDFDocument?
    
    // Add state for single vs all pages selection
    @State private var pageSelection: PageSelection = .singlePage
    
    // Add this to force preset menu updates
    @State private var presetsForceUpdate: UUID = UUID()
    
    // Add a reference to the filename editor view
    @State private var filenameEditorRef: FileNameEditor?
    
    private let numberFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 1
        formatter.minimumFractionDigits = 0 // Changed to 0 to hide decimal for whole numbers
        formatter.decimalSeparator = ","
        formatter.usesGroupingSeparator = false
        return formatter
    }()
    
    // Constants for height calculation
    private let baseContentHeight: CGFloat = 550 // Increased base height
    private let estimatedHeightPerAdjusterRow: CGFloat = 175

    // Calculates a suitable default/initial height, e.g., for 1 adjuster row.
    private var defaultCalculatedHeight: CGFloat {
        let dynamicContentHeight = 1 * estimatedHeightPerAdjusterRow // Assuming 1 adjuster for default height calculation
        let totalHeight = baseContentHeight + dynamicContentHeight
        // No selectedPDF check here for default, keep it simpler.
        return max(totalHeight, WindowManager.minHeight) 
    }

    // Helper for formatted size string
    private func formattedSize(_ size: CGSize) -> String {
        let width = size.width.toMillimeters // Uses extension from UnitExtensions.swift
        let height = size.height.toMillimeters // Uses extension from UnitExtensions.swift
        let widthStr = formatNumberSmart(width)
        let heightStr = formatNumberSmart(height)
        return "\(widthStr) × \(heightStr) mm"
    }

    // Smart number formatting: comma as decimal, no decimals if whole
    private func formatNumberSmart(_ value: CGFloat) -> String {
        return numberFormatter.string(from: NSNumber(value: Double(value))) ?? "\(value)"
    }

    var body: some View {
        VStack(spacing: 0) {
            contentScrollView
            bottomBarView
        }
        .frame(minWidth: WindowManager.fixedWidth, maxWidth: WindowManager.fixedWidth, minHeight: defaultCalculatedHeight, idealHeight: defaultCalculatedHeight, maxHeight: .infinity)
        .background(Color(NSColor.windowBackgroundColor))
        .background(WindowAccessor(window: $currentWindow))
        .onAppear {
            // Setup notification observer for preset changes
            let notificationCenter = NotificationCenter.default
            
            // Observer for visibility changes
            notificationCenter.addObserver(forName: NSNotification.Name("PresetVisibilityChanged"), 
                                          object: nil, 
                                          queue: .main) { _ in
                // Update the presetsForceUpdate ID to force refresh of preset menus
                self.presetsForceUpdate = UUID()
            }
            
            // Observer for preset list changes (new presets, updates)
            notificationCenter.addObserver(forName: NSNotification.Name("PresetListChanged"), 
                                          object: nil, 
                                          queue: .main) { _ in
                print("ContentView received PresetListChanged notification")
                // Update the presetsForceUpdate ID to force refresh of preset menus
                self.presetsForceUpdate = UUID()
            }
        }
        .onChange(of: currentWindow) { oldValue, newValue in
            if let window = newValue {
                WindowManager.shared.configureWindow(window)
            }
        }
    }

    // Extracted ScrollView Content
    @ViewBuilder
    private var contentScrollView: some View {
        ScrollView {
            VStack(alignment: .center, spacing: 20) {
                // PDF Selection and Info Area (condensed for brevity in this diff)
                VStack(spacing: 8) {
                    if let selectedPDF = selectedPDF {
                        ZStack(alignment: .center) {
                            PDFThumbnailView(url: selectedPDF, 
                                           onDrop: { url in handlePDFSelection(url) },
                                           bleedTrimAmount: bleedTrimAmount,
                                           currentResizeMode: sizeAdjusters.first?.resizeMode ?? .fillSize,
                                           targetSize: sizeAdjusters.first?.targetSize,
                                           showFillPreview: isFillModeAdjusterFocused(),
                                           currentPage: currentPage,
                                           totalPages: totalPages,
                                           onPageChange: { newPage in
                                               currentPage = newPage
                                               updateCurrentSizeFromPage(resetAdjuster: false)
                                           })
                                .frame(width: 250, height: 200)
                                .background(Color(NSColor.windowBackgroundColor))
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(Color.gray.opacity(0.2), lineWidth: 1)
                                )
                                .overlay(
                                    Button(action: {
                                        self.selectedPDF = nil; self.currentSize = nil; self.saveStatus = .idle; self.outputBaseName = ""; self.originalOutputBaseName = ""; self.currentPage = 0; self.totalPages = 1; self.pdfDocument = nil
                                    }) {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundColor(.secondary)
                                            .padding(8)
                                    }
                                    .buttonStyle(.plain)
                                    .padding(4),
                                    alignment: .topTrailing
                                )
                                .id("\(sizeAdjusters.first?.resizeMode ?? .fillSize)-\(sizeAdjusters.first?.targetSize.width ?? 0)-\(sizeAdjusters.first?.targetSize.height ?? 0)-\(bleedTrimAmount)-\(isFillModeAdjusterFocused())-\(currentPage)")
                        }
                    } else {
                        PDFDropImageView(selectedPDF: $selectedPDF) { url in handlePDFSelection(url) }
                            .frame(width: 250, height: 200)
                            .background(Color(NSColor.windowBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(Color.gray.opacity(0.2), lineWidth: 1)
                            )
                            .overlay(
                                Text("Drop PDF here or click to select")
                                    .foregroundColor(.secondary)
                            )
                    }
                    VStack(alignment: .center, spacing: 4) {
                        if let selectedPDF = selectedPDF {
                            Text(selectedPDF.lastPathComponent)
                                .foregroundColor(.primary)
                        }
                        if let currentSize = currentSize {
                            HStack(spacing: 4) {
                                // Original size - always displayed
                                Text(formattedSize(currentSize))
                                    .foregroundColor(.secondary)
                                    .font(.caption)
                                
                                // Reset button for non-trimmed state
                                Group {
                                    // Only show in non-trimmed state
                                    if bleedTrimAmount <= 0 {
                                        // Change detection logic to avoid showing when just focusing
                                        let hasSignificantChanges = !sizeAdjusters.isEmpty && 
                                            sizeAdjusters.first.map { adjuster in
                                                let sizeToCompare = currentSize
                                                
                                                // Only consider it a change if the difference is significant
                                                let widthDiff = abs(adjuster.targetSize.width - sizeToCompare.width)
                                                let heightDiff = abs(adjuster.targetSize.height - sizeToCompare.height)
                                                
                                                // Consider it changed if at least 0.5 points different
                                                return widthDiff > 0.5 || heightDiff > 0.5
                                            } ?? false
                                        
                                        // Only show reset button when there are actual changes
                                        if hasSignificantChanges {
                                            Button(action: {
                                                focusedField = nil
                                                resetSizeAdjusterToPDFDimensions(pdfSize: currentSize)
                                            }) {
                                                Image(systemName: "hand.pinch.fill")
                                                    .font(.caption)
                                                    .foregroundColor(.secondary)
                                            }
                                            .buttonStyle(.plain)
                                            .help("Reset size adjuster to PDF dimensions")
                                            .transition(.opacity.combined(with: .scale))
                                        }
                                    }
                                }
                                .animation(.easeInOut(duration: 0.3), value: bleedTrimAmount)
                                
                                // Spacer - always present
                                Spacer().frame(width: 8)
                                
                                // Trim control - always present
                                Text("Trim:")
                                    .foregroundColor(.secondary)
                                    .font(.caption)
                                
                                // Trim field - always present with the same structure
                                StepperTextField(
                                    value: $bleedTrimAmount,
                                    formatter: numberFormatter,
                                    minValue: 0,
                                    maxValue: 20,
                                    onCommit: {
                                        // Explicitly delay clearing focus to avoid issues
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                            print("*** Trim field onCommit handler - maintaining focus")
                                            // Do not clear focus here - let natural focus flow happen
                                        }
                                    }
                                )
                                .frame(width: 45)
                                .focused($focusedField, equals: .bleedTrim)
                                .id("trimField") // Fixed ID to maintain field identity
                                
                                // Trimmed size section with reset button after it
                                Group {
                                    if bleedTrimAmount > 0 {
                                        // Calculate effective size after bleed trim
                                        let effectiveSize = PDFProcessor.calculateEffectiveSizeAfterBleedTrim(currentSize: currentSize, bleedTrimAmount: bleedTrimAmount)
                                        
                                        // Arrow and resulted size without spacers
                                        Text("→")
                                            .foregroundColor(.secondary)
                                            .font(.caption)
                                        Text(formattedSize(effectiveSize))
                                            .foregroundColor(.secondary)
                                            .font(.caption)
                                            .transition(.opacity)
                                        
                                        // Reset button for trimmed state - MOVED HERE, REDUCED SPACING
                                        Spacer().frame(width: 2)
                                        
                                        // Change detection logic
                                        let hasSignificantChanges = !sizeAdjusters.isEmpty && 
                                            sizeAdjusters.first.map { adjuster in
                                                // Only consider it a change if the difference is significant
                                                let widthDiff = abs(adjuster.targetSize.width - effectiveSize.width)
                                                let heightDiff = abs(adjuster.targetSize.height - effectiveSize.height)
                                                
                                                // Consider it changed if at least 0.5 points different
                                                return widthDiff > 0.5 || heightDiff > 0.5
                                            } ?? false
                                        
                                        // Only show reset button when there are actual changes
                                        if hasSignificantChanges {
                                            Button(action: {
                                                focusedField = nil
                                                resetSizeAdjusterToPDFDimensions(pdfSize: effectiveSize)
                                            }) {
                                                Image(systemName: "hand.pinch.fill")
                                                    .font(.caption)
                                                    .foregroundColor(.secondary)
                                            }
                                            .buttonStyle(.plain)
                                            .help("Reset size adjuster to trimmed PDF dimensions")
                                            .transition(.opacity.combined(with: .scale))
                                        }
                                    }
                                }
                                .animation(.easeInOut(duration: 0.4), value: bleedTrimAmount)
                            }
                            .animation(.easeInOut(duration: 0.3), value: bleedTrimAmount > 0)

                            // Add page selection radio buttons if PDF has multiple pages
                            if totalPages > 1 {
                                HStack(spacing: 16) {
                                    Text("Process:")
                                        .foregroundColor(.secondary)
                                        .font(.caption)
                                    
                                    // Radio button for Single Page
                                    HStack(spacing: 4) {
                                        Image(systemName: pageSelection == .singlePage ? "circle.inset.filled" : "circle")
                                            .foregroundColor(pageSelection == .singlePage ? .accentColor : .secondary)
                                            .font(.caption)
                                        Text("Single Page")
                                            .foregroundColor(.secondary)
                                            .font(.caption)
                                    }
                                    .contentShape(Rectangle())
                                    .onTapGesture {
                                        pageSelection = .singlePage
                                    }
                                    
                                    // Radio button for All Pages
                                    HStack(spacing: 4) {
                                        Image(systemName: pageSelection == .allPages ? "circle.inset.filled" : "circle")
                                            .foregroundColor(pageSelection == .allPages ? .accentColor : .secondary)
                                            .font(.caption)
                                        Text("All Pages")
                                            .foregroundColor(.secondary)
                                            .font(.caption)
                                    }
                                    .contentShape(Rectangle())
                                    .onTapGesture {
                                        pageSelection = .allPages
                                    }
                                }
                                .padding(.top, 4)
                                .padding(.bottom, 4)
                                .transition(.opacity)
                            }
                        } else {
                            Text(" ")  // Empty space holder
                                .foregroundColor(.secondary)
                                .font(.caption)
                        }
                    }
                    .frame(height: totalPages > 1 ? 65 : 40) // Increase height when radio buttons are shown
                }
                
                // Size Adjusters Section
                VStack {
                    // Previously:
                    // let aspectRatio = currentSize.map { $0.height != 0 ? ($0.width / $0.height) : 1.0 }
                    
                    // Update to use the aspect ratio of the trimmed size when bleed is applied
                    let aspectRatio: CGFloat? = currentSize.map { 
                        if bleedTrimAmount > 0 {
                            // Use the aspect ratio of the trimmed size
                            let effectiveSize = PDFProcessor.calculateEffectiveSizeAfterBleedTrim(
                                currentSize: $0, bleedTrimAmount: bleedTrimAmount)
                            return effectiveSize.width / effectiveSize.height
                        } else {
                            // Use original aspect ratio when no trimming
                            return $0.height != 0 ? ($0.width / $0.height) : 1.0
                        }
                    }
                    
                    ForEach(sizeAdjusters) { adjuster in
                        let displaySize = PDFProcessor.calculateResultingSize(for: adjuster, currentSize: currentSize, bleedTrimAmount: bleedTrimAmount)
                        SizeAdjusterRow(adjuster: adjuster, sizeAdjusters: $sizeAdjusters, numberFormatter: numberFormatter, focusedField: $focusedField, resultingSize: displaySize, aspectRatio: aspectRatio)
                    }
                    Button(action: {
                        withAnimation {
                            if let last = sizeAdjusters.last {
                                sizeAdjusters.append(SizeAdjuster(resizeMode: last.resizeMode, targetSize: last.targetSize))
                            } else {
                                sizeAdjusters.append(SizeAdjuster())
                            }
                        }
                    }) {
                        HStack(spacing: 6) {
                            Image(systemName: "plus.circle.fill")
                                .foregroundColor(.accentColor)
                            Text("Add Size")
                        }
                    }
                    .buttonStyle(.plain).padding(.top, 6)
                }
                .animation(.easeInOut, value: sizeAdjusters)
                .onChange(of: bleedTrimAmount) { oldValue, newValue in
                    // Force refresh of size adjusters when bleed trim amount changes
                    // No need to modify the sizeAdjusters themselves, just trigger a recalculation
                    if oldValue != newValue {
                        // The change in aspectRatio is handled automatically by the view update
                        
                        // Reset success/error states when user changes trim amount
                        if saveStatus == .success || saveStatus == .error || saveStatus == .fileExistsWarning {
                            saveStatus = .idle
                            isProcessing = false
                        }
                    }
                }

                // Filename Section - use a simpler approach with more direct focus detection
                VStack(alignment: .leading, spacing: 8) {
                    Text("Filename:").frame(maxWidth: .infinity, alignment: .leading)
                    
                    // Create a flag to track if the filename editor is focused
                    let editor = FileNameEditor(
                        fileName: $outputBaseName, 
                        originalFileName: $originalOutputBaseName, 
                        disabled: selectedPDF == nil, 
                        onFocusChange: { focused in
                            // Use DispatchQueue to avoid state update conflicts
                            DispatchQueue.main.async {
                                focusedField = focused ? .fileName : nil
                            }
                        }
                    )
                    
                    editor
                        .onChange(of: outputBaseName) { 
                            if saveStatus == .success || saveStatus == .error || saveStatus == .fileExistsWarning { 
                                saveStatus = .idle
                                isProcessing = false 
                            }
                        }
                    
                    // Use a direct check on NSApp.keyWindow?.firstResponder for focus detection
                    let isFieldFocused = checkIfFileNameFieldIsFocused()
                    
                    TokensRow(
                        outputBaseName: $outputBaseName, 
                        isFocused: isFieldFocused,
                        insertTextAtCursor: { text in editor.insertTextAtCursor(text) }
                    )
                    .disabled(selectedPDF == nil)
                    .id(isFieldFocused) // Force refresh when focus changes
                }.padding(.horizontal)
                
                // Export Location Section
                VStack(alignment: .leading, spacing: 4) { 
                    Text("Export location:").frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 8) { 
                        FolderPopUpButton(url: $saveFolder).frame(width: 215).disabled(selectedPDF == nil)
                            .onChange(of: saveFolder) { if saveStatus == .success || saveStatus == .error || saveStatus == .fileExistsWarning { saveStatus = .idle; isProcessing = false } }
                        Toggle("Subfolder", isOn: $useSubfolder).toggleStyle(.checkbox).disabled(selectedPDF == nil)
                            .onChange(of: useSubfolder) { if saveStatus == .success || saveStatus == .error || saveStatus == .fileExistsWarning { saveStatus = .idle; isProcessing = false } }
                        TextField("Subfolder name", text: $subfolderName)
                            .textFieldStyle(RoundedBorderTextFieldStyle())
                            .disabled(!useSubfolder || selectedPDF == nil)
                            .onChange(of: subfolderName) { if saveStatus == .success || saveStatus == .error || saveStatus == .fileExistsWarning { saveStatus = .idle; isProcessing = false } }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.padding(.horizontal)
            }
            .padding(.vertical, 20)
            .padding(.bottom, 60)
        }
    }
    
    // Add helper method to update currentSize based on selected page
    private func updateCurrentSizeFromPage(resetAdjuster: Bool = true) {
        // Ensure we're on the main thread for UI updates
        if !Thread.isMainThread {
            DispatchQueue.main.async {
                self.updateCurrentSizeFromPage(resetAdjuster: resetAdjuster)
            }
            return
        }
        
        if let pdfDocument = pdfDocument, let page = pdfDocument.page(at: currentPage) {
            // Process page info on high-priority background thread if it's computationally intensive
            DispatchQueue.global(qos: .userInteractive).async {
                let pageSize = page.bounds(for: .mediaBox).size
                
                // Update UI on main thread
                DispatchQueue.main.async {
                    self.currentSize = pageSize
                    
                    // Only update the size adjuster if resetAdjuster is true
                    if resetAdjuster && !self.sizeAdjusters.isEmpty {
                        // Create a new adjuster with current mode but new page dimensions
                        let currentMode = self.sizeAdjusters[0].resizeMode
                        let newAdjuster = SizeAdjuster(id: UUID(), resizeMode: currentMode, targetSize: pageSize)
                        
                        // Replace the first adjuster with our new one
                        var newAdjusters = self.sizeAdjusters
                        newAdjusters[0] = newAdjuster
                        self.sizeAdjusters = newAdjusters
                    }
                }
            }
        }
    }
    
    private func handlePDFSelection(_ url: URL) {
        guard url.startAccessingSecurityScopedResource() else {
            saveStatus = .permissionError
            showPermissionErrorPopover = true
            return
        }
        
        // Capture the URL for cleanup
        let urlToCleanup = url
        
        // Ensure any existing PDF document reference is released properly
        if self.pdfDocument != nil {
            self.pdfDocument = nil
        }
        
        selectedPDF = url
        
        // Use a moderate priority queue for PDF document loading
        DispatchQueue.global(qos: .userInitiated).async {
            // Load the PDF document and get page count
            let newPdfDocument = PDFKit.PDFDocument(url: url)
            
            // Always stop accessing the resource when done with loading
            urlToCleanup.stopAccessingSecurityScopedResource()
            
            if let document = newPdfDocument {
                let totalPageCount = document.pageCount
                
                // Update UI-related properties on the main thread
                DispatchQueue.main.async {
                    self.pdfDocument = document
                    self.totalPages = totalPageCount
                    self.currentPage = 0
                    
                    // Reset processing state
                    self.isProcessing = false
                    self.saveStatus = .idle
                    
                    // Update save folder and filename
                    self.saveFolder = url.deletingLastPathComponent()
                    let baseName = url.deletingPathExtension().lastPathComponent
                    self.outputBaseName = baseName
                    self.originalOutputBaseName = baseName
                    
                    // Reset bleed trim amount when loading a new PDF
                    self.bleedTrimAmount = 0
                    
                    // Try to get actual page dimensions from first page 
                    if let firstPage = document.page(at: 0) {
                        let bounds = firstPage.bounds(for: .mediaBox)
                        self.currentSize = bounds.size
                        print("PDF loaded successfully - Document: \(totalPageCount) pages, First page size: \(bounds.size.width)x\(bounds.size.height) points")
                        
                        // Update size adjusters with the new dimensions if we don't have any yet
                        if self.sizeAdjusters.isEmpty {
                            self.sizeAdjusters.append(SizeAdjuster(resizeMode: .fillSize, targetSize: bounds.size))
                        }
                    } else {
                        print("Warning: Could not get bounds from first page")
                    }
                }
            } else {
                DispatchQueue.main.async {
                    print("Error: Failed to load PDF document from \(url)")
                    self.selectedPDF = nil
                    self.saveStatus = .error
                }
            }
        }
    }
    
    private func दशकProcessPDFsAction() {
        guard let inputURL = selectedPDF else { return }
        guard let folderURL = saveFolder else { return }
        guard !outputBaseName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            print("Error: Output base name is missing in दशकProcessPDFsAction.")
            saveStatus = .error
            return
        }
        
        saveStatus = .idle
        isProcessing = true

        let baseForProcessing = outputBaseName

        // Get the pages to process based on user selection
        let pagesToProcess: [Int]
        if totalPages > 1 && pageSelection == .allPages {
            // Process all pages
            pagesToProcess = Array(0..<totalPages)
        } else {
            // Process only the current page
            pagesToProcess = [currentPage]
        }

        // MODIFIED: Generate prospective file paths for all pages to process
        let (prospectiveURLs, prospectiveAdjusterIDs) = PDFProcessor.generateProspectiveFilePaths(
            inputURL: inputURL, 
            saveFolderURL: folderURL, 
            sizeAdjusters: sizeAdjusters,
            baseFileName: baseForProcessing,
            useSubfolder: useSubfolder, 
            subfolderName: subfolderName,
            currentPDFSize: currentSize,
            bleedTrimAmount: bleedTrimAmount,
            pageIndices: pagesToProcess // Pass all pages to process
        )

        var allProspectiveItems: [ConflictingFileItem] = []
        let fileManager = FileManager.default
        var hasAnyConflict = false

        // MODIFIED: Iterate with index to access corresponding adjusterID
        for (index, url) in prospectiveURLs.enumerated() {
            let isAConflict = fileManager.fileExists(atPath: url.path)
            if isAConflict { hasAnyConflict = true }
            let adjusterIdForThisFile = prospectiveAdjusterIDs[index] // Get the ID
            allProspectiveItems.append(ConflictingFileItem(fileName: url.lastPathComponent,
                                                           shouldOverwrite: isAConflict,
                                                           isConflict: isAConflict,
                                                           adjusterID: adjusterIdForThisFile)) // Store the ID
        }
        
        self.filesToProcess = allProspectiveItems

        if hasAnyConflict {
            self.saveStatus = .fileExistsWarning
            self.showFileExistsPopover = true
            self.isProcessing = false 
            return
        }

        actuallyProcessAndSavePDFs(inputURL: inputURL, folderURL: folderURL, adjustersToProcess: sizeAdjusters, overwriteIntentForAllInBatch: true)
    }

    private func actuallyProcessAndSavePDFs(inputURL: URL, folderURL: URL, adjustersToProcess: [SizeAdjuster], overwriteIntentForAllInBatch: Bool) {
        guard !outputBaseName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            print("Error: Output base name is missing in actuallyProcessAndSavePDFs.")
            DispatchQueue.main.async {
                isProcessing = false
                saveStatus = .error
            }
            return
        }

        if adjustersToProcess.isEmpty {
            print("actuallyProcessAndSavePDFs called with no adjusters to process. Setting status to idle.")
            DispatchQueue.main.async {
                isProcessing = false
                saveStatus = .idle
            }
            return
        }

        // Determine the pages to process based on UI settings
        let pagesToProcess: [Int]
        if let pdfDoc = self.pdfDocument {
            if pageSelection == .singlePage && currentPage >= 0 && currentPage < pdfDoc.pageCount {
                pagesToProcess = [currentPage] // currentPage is already 0-based
            } else {
                // Process all pages
                pagesToProcess = Array(0..<pdfDoc.pageCount)
            }
        } else {
            pagesToProcess = [0] // Default to first page
        }

        print("Processing \(adjustersToProcess.count) adjusters for \(pagesToProcess.count) pages with overwrite: \(overwriteIntentForAllInBatch)")

        let baseForProcessing = outputBaseName

        DispatchQueue.global(qos: .userInteractive).async {
            // Use a dispatch group to track completion of all processing
            let processingGroup = DispatchGroup()
            processingGroup.enter()
            
            var processingResults: (savedFiles: [String], errors: [String])?
            
            // Access the security scoped resource before processing
            guard inputURL.startAccessingSecurityScopedResource() else {
                DispatchQueue.main.async {
                    self.isProcessing = false
                    self.saveStatus = .error
                }
                processingGroup.leave()
                return
            }
            
            let results = PDFProcessor.processAndSavePDFs(
                inputURL: inputURL,
                saveFolderURL: folderURL,
                sizeAdjusters: adjustersToProcess,
                baseFileName: baseForProcessing,
                useSubfolder: self.useSubfolder,
                subfolderName: self.subfolderName,
                currentPDFSize: self.currentSize,
                bleedTrimAmount: self.bleedTrimAmount,
                allowOverwrite: overwriteIntentForAllInBatch,
                pageIndices: pagesToProcess // Pass all pages to process
            )
            processingResults = results
            
            // Always clean up resources when done
            inputURL.stopAccessingSecurityScopedResource()
            processingGroup.leave()
            
            // Wait for all processing to complete with a reasonable timeout
            _ = processingGroup.wait(timeout: .now() + 30.0)
            
            DispatchQueue.main.async {
                self.isProcessing = false
                
                if let results = processingResults {
                    if !results.errors.isEmpty || results.savedFiles.isEmpty {
                        self.saveStatus = .error
                        print("PDF processing completed with errors: \(results.errors)")
                    } else {
                        self.saveStatus = .success
                        print("PDF processing completed successfully, saved \(results.savedFiles.count) files")
                    }
                } else {
                    self.saveStatus = .error
                    print("PDF processing failed with no results")
                }
            }
        }
    }

    // MARK: - Filename Pattern Helpers (NEW)
    static func stringContainsSizePattern(_ text: String) -> Bool { 
        // Match size patterns like _100x200_ (with underscores on both sides)
        // or _100x200 (with underscore at start only)
        // or 100x200_ (with underscore at end only)
        // or 100x200 (with no underscores, only at word boundaries)
        // Both Latin "x" and Cyrillic "х" characters are supported
        
        // First try patterns with underscore(s)
        guard let regexSizePattern = try? NSRegularExpression(pattern: "(_\\d+[xх]\\d+_)|(_\\d+[xх]\\d+$)|(^\\d+[xх]\\d+_)|(\\b\\d+[xх]\\d+\\b)") else { return false }
        
        // Check for standard dimension pattern
        if regexSizePattern.firstMatch(in: text, options: [], range: NSRange(location: 0, length: text.utf16.count)) != nil {
            return true
        }
        
        // Check for A-series paper sizes (both Latin and Cyrillic)
        // Matches A0-A5 with optional h/v orientation specifier
        // Can be surrounded by delimiters or at start/end of string
        guard let regexPaperSizePattern = try? NSRegularExpression(pattern: "(^|[_\\-\\s])[AА][0-5][hv]?($|[_\\-\\s])") else { return false }
        return regexPaperSizePattern.firstMatch(in: text, options: [], range: NSRange(location: 0, length: text.utf16.count)) != nil
    }

    static func stringContainsDatePattern(_ text: String) -> Bool { 
        // MODIFIED: Escaped regex pattern
        guard let regex = try? NSRegularExpression(pattern: "(?<!\\d)\\d{6}(?!\\d)") else { return false }
        return regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: text.utf16.count)) != nil
    }

    static func replaceSizePattern(in text: String, with replacementToken: String) -> String { 
        // First try to replace dimension pattern with various boundary conditions
        guard let regexSizePattern = try? NSRegularExpression(pattern: "(_\\d+[xх]\\d+_)|(_\\d+[xх]\\d+$)|(^\\d+[xх]\\d+_)|(\\b\\d+[xх]\\d+\\b)") else { return text }
        let afterDimensionReplace = regexSizePattern.stringByReplacingMatches(
            in: text, 
            options: [], 
            range: NSRange(location: 0, length: text.utf16.count), 
            withTemplate: replacementToken
        )
        
        // If we made a replacement, return it
        if afterDimensionReplace != text {
            return afterDimensionReplace
        }
        
        // Otherwise try to replace A-series paper pattern
        guard let regexPaperSizePattern = try? NSRegularExpression(pattern: "(^|[_\\-\\s])[AА][0-5][hv]?($|[_\\-\\s])") else { return text }
        return regexPaperSizePattern.stringByReplacingMatches(
            in: text, 
            options: [], 
            range: NSRange(location: 0, length: text.utf16.count), 
            withTemplate: replacementToken
        )
    }

    static func replaceFirstDatePattern(in text: String, with replacementToken: String) -> String { 
        // MODIFIED: Escaped regex pattern
        guard let regex = try? NSRegularExpression(pattern: "(?<!\\d)\\d{6}(?!\\d)") else { return text }
        if let firstMatch = regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: text.utf16.count)) {
            if let range = Range(firstMatch.range, in: text) {
                return text.replacingCharacters(in: range, with: replacementToken)
            }
        }
        return text
    }

    // Helper function to check if a fill mode adjuster is focused
    private func isFillModeAdjusterFocused() -> Bool {
        // Check if any SizeAdjuster with fillSize mode has focus in either width or height field
        for adjuster in sizeAdjusters {
            if adjuster.resizeMode == .fillSize {
                // Check if width or height field of this adjuster has focus
                if focusedField == .width(adjuster.id) || focusedField == .height(adjuster.id) {
                    return true
                }
            }
        }
        return false
    }

    // Helper method to directly check if the filename field has focus
    private func checkIfFileNameFieldIsFocused() -> Bool {
        // Try several ways to determine if the text field is focused
        
        // 1. Check if our FocusState thinks it's focused
        if focusedField == .fileName {
            print("Focus check: FocusState says field is focused")
            return true
        }
        
        // 2. Check if the first responder is relevant to our text field
        if let window = NSApplication.shared.keyWindow,
           let firstResponder = window.firstResponder {
            
            // Check if first responder is a text view (field editor)
            if let textView = firstResponder as? NSTextView {
                print("Focus check: Found NSTextView as first responder")
                
                // Check if it has any selected text or cursor
                if textView.selectedRange().location != NSNotFound {
                    print("Focus check: NSTextView has selection or cursor")
                    return true
                }
                
                // Check if the delegate is related to our text field
                if let textField = textView.delegate as? NSTextField {
                    print("Focus check: NSTextView delegate is NSTextField")
                    
                    if textField.identifier?.rawValue == "TokenFormattingTextField" {
                        print("Focus check: TextField is TokenFormattingTextField")
                        return true
                    }
                }
                
                // Check window match as last resort
                if textView.window == window {
                    print("Focus check: NSTextView window matches our window")
                    return true
                }
            }
            
            // Check if first responder is directly our text field
            if let textField = firstResponder as? NSTextField,
               textField.identifier?.rawValue == "TokenFormattingTextField" {
                print("Focus check: First responder is directly TokenFormattingTextField")
                return true
            }
        }
        
        // 3. Always return true if we've recently interacted with the text field
        // This is a hack, but it can help with edge cases
        print("Focus check: None of our checks passed, field is NOT focused")
        return false
    }

    // Extracted Bottom Bar View
    @ViewBuilder
    private var bottomBarView: some View {
        HStack(spacing: 8) {
            Spacer()
            Spacer().frame(width: 28)
            Button("Save", action: दशकProcessPDFsAction)
                .buttonStyle(.bordered)
                .controlSize(.large)
                .frame(idealHeight: 44, maxHeight: 44)
                .disabled(isProcessing || selectedPDF == nil)
            let iconInfo = statusIcon
            Image(systemName: iconInfo.systemName)
                .font(.title3)
                .foregroundColor(iconInfo.color)
                .if(iconInfo.renderingMode != nil) { $0.symbolRenderingMode(iconInfo.renderingMode!) }
                .frame(width: 28, height: 28, alignment: .center)
                .scaleEffect(iconScaleEffect)
                .animation(.easeInOut(duration: 0.2), value: iconInfo.systemName)
                .padding(.leading, 0)
                .onTapGesture {
                    print("Status icon tapped. Current saveStatus: \(saveStatus), showFileExistsPopover: \(showFileExistsPopover)") // DEBUG
                    if saveStatus == .fileExistsWarning {
                        showFileExistsPopover = true
                    } else if saveStatus == .permissionError {
                        showPermissionErrorPopover = true
                    }
                }
                .popover(isPresented: $showFileExistsPopover, arrowEdge: .top) { fileExistsPopoverView }
                .popover(isPresented: $showPermissionErrorPopover, arrowEdge: .top) { permissionErrorPopoverView }
            Spacer()
        }
        .frame(height: 56)
        .background(VisualEffectView(material: .sidebar, blendingMode: .withinWindow))
        .shadow(color: Color.black.opacity(0.06), radius: 4, y: -2)
    }
    
    // Popover View Builder
    @ViewBuilder
    private var fileExistsPopoverView: some View {
        VStack(alignment: .leading, spacing: 12) {
            List($filesToProcess) { $item in
                FileConflictRowView(item: $item)
            }
            .listStyle(.plain)
            .frame(minHeight: 100, maxHeight: 250)
            
            HStack {
                Spacer()
                Button("Cancel") {
                    showFileExistsPopover = false
                    saveStatus = .idle
                    isProcessing = false
                }
                .keyboardShortcut(.cancelAction)
                
                let shouldOverwriteAnyConflict = filesToProcess.contains { $0.isConflict && $0.shouldOverwrite }
                Button(shouldOverwriteAnyConflict ? "Overwrite" : "Continue") { 
                    showFileExistsPopover = false
                    
                    
                    var adjustersToActuallyProcess: [SizeAdjuster] = []
                    for item in filesToProcess {
                        if !item.isConflict || item.shouldOverwrite { 
                            if let adjuster = sizeAdjusters.first(where: { $0.id == item.adjusterID }) {
                                adjustersToActuallyProcess.append(adjuster)
                            }
                        }
                    }

                    if let inputURL = selectedPDF, let folderURL = saveFolder {
                        if adjustersToActuallyProcess.isEmpty && filesToProcess.contains(where: {$0.isConflict && !$0.shouldOverwrite}) {
                            saveStatus = .idle 
                            isProcessing = false
                        } else if adjustersToActuallyProcess.isEmpty && filesToProcess.allSatisfy({ !$0.isConflict }) {
                            saveStatus = .idle
                            isProcessing = false
                        } else if !adjustersToActuallyProcess.isEmpty {
                            actuallyProcessAndSavePDFs(inputURL: inputURL, folderURL: folderURL, 
                                                       adjustersToProcess: adjustersToActuallyProcess, 
                                                       overwriteIntentForAllInBatch: true)
                        } else {
                            saveStatus = .idle 
                            isProcessing = false
                        }
                    } else {
                        saveStatus = .error
                        isProcessing = false
                    }
                }
                .tint(shouldOverwriteAnyConflict ? .red : .accentColor) 
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding()
        .frame(minWidth: 400, idealWidth: 450)
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(8)
    }
    
    // Add the permission error popover view
    @ViewBuilder
    private var permissionErrorPopoverView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(.red)
                    .font(.system(size: 20))
                
                VStack(alignment: .leading, spacing: 8) {
                    Text("You do not have permission to open the document \"\(selectedPDF?.lastPathComponent ?? "*.pdf")\".")
                        .fontWeight(.medium)
                    
                    Text("Contact your computer or network administrator for assistance.")
                        .foregroundColor(.secondary)
                }
            }
            
            Divider()
            
            HStack {
                Spacer()
                Button("OK") {
                    showPermissionErrorPopover = false
                    saveStatus = .idle
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding()
        .frame(width: 400)
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(8)
    }
    
    // Computed property for the status icon
    private var statusIcon: (systemName: String, color: Color?, renderingMode: SymbolRenderingMode?) {
        if isProcessing {
            return ("circle.fill", nil, .hierarchical)
        }

        switch saveStatus {
        case .success:
            return ("checkmark.circle.fill", .green, nil)
        case .error:
            return ("xmark.circle.fill", .red, nil)
        case .fileExistsWarning:
            return ("exclamationmark.triangle.fill", .yellow, .monochrome)
        case .permissionError:
            return ("lock.fill", .red, .monochrome)
        case .idle:
            if selectedPDF != nil {
                return ("circle.dotted.circle.fill", nil, .hierarchical)
            } else {
                return ("circle", Color(NSColor.disabledControlTextColor), nil)
            }
        }
    }
    
    private func resetSizeAdjusterToPDFDimensions(pdfSize: CGSize) {
        // Don't do anything if there are no adjusters
        guard !sizeAdjusters.isEmpty else { return }
        
        // Create a new adjuster with a new ID but keeping the same mode
        // This forces the SizeAdjusterRow to completely rebuild and reset its internal state
        let currentMode = sizeAdjusters[0].resizeMode
        let newAdjuster = SizeAdjuster(id: UUID(), resizeMode: currentMode, targetSize: pdfSize)
        
        // Replace the first adjuster
        var newAdjusters = sizeAdjusters
        newAdjusters[0] = newAdjuster
        
        // Add a subtle animation effect
        withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
            sizeAdjusters = newAdjusters
        }
    }

    // Enhanced version of the PDF thumbnail generator that includes all required parameters
    func generatePDFThumbnail(for url: URL, page pageIndex: Int, bleedTrimAmount: CGFloat = 0, resizeMode: ResizeMode = .fillSize, targetSize: CGSize? = nil, showFillPreview: Bool = false, completion: @escaping (NSImage?) -> Void) {
        // Use background queue to avoid blocking UI, but use completion callback to avoid deadlocks
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
                // Ensure we can access the security-scoped resource
                let canAccess = url.startAccessingSecurityScopedResource()
                defer {
                    // Always stop accessing when we're done, regardless of how we exit this block
                    if canAccess {
                        url.stopAccessingSecurityScopedResource()
                    }
                }
                
                guard canAccess, 
                      let pdfDocument = PDFKit.PDFDocument(url: url),
                      let page = pdfDocument.page(at: pageIndex) else {
                    print("Failed to load PDF or page for thumbnail generation")
                    DispatchQueue.main.async {
                        completion(nil)
                    }
                    return
                }
                
                // Generate thumbnail with fixed size (like original)
                let thumbSize = NSSize(width: 250, height: 200)
                let pageRect = page.bounds(for: .mediaBox)
                
                // Calculate scale to fit within the view bounds
                let scale = min(thumbSize.width / pageRect.width, thumbSize.height / pageRect.height)
                let targetWidth = pageRect.width * scale
                let targetHeight = pageRect.height * scale
                
                // Create image with the view size to ensure proper centering
                let image = NSImage(size: thumbSize)
                image.lockFocus()
                defer { image.unlockFocus() }
                
                // Calculate position to center the content
                let x = (thumbSize.width - targetWidth) / 2
                let y = (thumbSize.height - targetHeight) / 2
                
                // Full PDF area rectangle in view coordinates
                let fullRect = CGRect(x: x, y: y, width: targetWidth, height: targetHeight)
                
                // Get current graphics context
                guard let ctx = NSGraphicsContext.current?.cgContext else {
                    print("Could not get graphics context for thumbnail")
                    DispatchQueue.main.async {
                        completion(nil)
                    }
                    return
                }
                
                // Draw white background for the whole PDF
                ctx.saveGState()
                NSColor.white.set()
                NSRect(x: x, y: y, width: targetWidth, height: targetHeight).fill()
                ctx.restoreGState()
                
                // Draw the PDF content
                ctx.saveGState()
                ctx.translateBy(x: x, y: y)
                ctx.scaleBy(x: scale, y: scale)
                page.draw(with: .mediaBox, to: ctx)
                ctx.restoreGState()
                
                // Calculate the effective rect after trimming (if trim is active)
                var effectiveRect = fullRect
                if bleedTrimAmount > 0 {
                    // Convert bleedTrimAmount from mm to points
                    let bleedTrimPoints = CGFloat.fromMillimeters(bleedTrimAmount)
                    
                    // Calculate the effective rect after trimming (in scaled coordinates)
                    effectiveRect = CGRect(
                        x: x + (bleedTrimPoints * scale),
                        y: y + (bleedTrimPoints * scale),
                        width: targetWidth - (2 * bleedTrimPoints * scale),
                        height: targetHeight - (2 * bleedTrimPoints * scale)
                    )
                    
                    // Apply trim overlay
                    ctx.saveGState()
                    
                    // Draw dark overlay for trimmed areas (top, bottom, left, right)
                    ctx.setFillColor(NSColor.black.withAlphaComponent(0.4).cgColor)
                    
                    // Top trim area
                    ctx.fill(CGRect(x: fullRect.minX, y: effectiveRect.maxY, 
                                  width: fullRect.width, height: fullRect.maxY - effectiveRect.maxY))
                    
                    // Bottom trim area
                    ctx.fill(CGRect(x: fullRect.minX, y: fullRect.minY, 
                                  width: fullRect.width, height: effectiveRect.minY - fullRect.minY))
                    
                    // Left trim area
                    ctx.fill(CGRect(x: fullRect.minX, y: effectiveRect.minY, 
                                  width: effectiveRect.minX - fullRect.minX, height: effectiveRect.height))
                    
                    // Right trim area
                    ctx.fill(CGRect(x: effectiveRect.maxX, y: effectiveRect.minY, 
                                  width: fullRect.maxX - effectiveRect.maxX, height: effectiveRect.height))
                    
                    // Draw white 1pt border around active area
                    ctx.setStrokeColor(NSColor.white.cgColor)
                    ctx.setLineWidth(1.0)
                    ctx.stroke(effectiveRect)
                    
                    ctx.restoreGState()
                }
                
                // Apply fill/fit visualization if conditions are met:
                // 1. We have target dimensions
                // 2. We're in Fill mode
                // 3. showFillPreview flag is true (user is focused on this adjuster)
                if let targetSize = targetSize, resizeMode == .fillSize, showFillPreview {
                    // Use the effective (trimmed) rect for fill calculations
                    let effectiveWidth = effectiveRect.width
                    let effectiveHeight = effectiveRect.height
                    let currentAR = effectiveWidth / effectiveHeight
                    let targetAR = targetSize.width / targetSize.height
                    
                    // Calculate the scaled dimensions that would be visible in fill mode
                    var visibleRect = effectiveRect
                    
                    if currentAR > targetAR {
                        // Current is wider than target: crop sides
                        let scaledTargetWidth = effectiveHeight * targetAR
                        let trimFromSides = (effectiveWidth - scaledTargetWidth) / 2
                        visibleRect = CGRect(
                            x: effectiveRect.minX + trimFromSides,
                            y: effectiveRect.minY,
                            width: effectiveWidth - (2 * trimFromSides),
                            height: effectiveHeight
                        )
                    } else if currentAR < targetAR {
                        // Current is taller than target: crop top/bottom
                        let scaledTargetHeight = effectiveWidth / targetAR
                        let trimFromTopBottom = (effectiveHeight - scaledTargetHeight) / 2
                        visibleRect = CGRect(
                            x: effectiveRect.minX,
                            y: effectiveRect.minY + trimFromTopBottom,
                            width: effectiveWidth,
                            height: effectiveHeight - (2 * trimFromTopBottom)
                        )
                    }
                    
                    // Only draw overlay if aspect ratios don't match (with small tolerance)
                    if abs(currentAR - targetAR) > 0.01 {
                        ctx.saveGState()
                        
                        // Draw dark overlay for areas that would be cropped in fill mode
                        ctx.setFillColor(NSColor.black.withAlphaComponent(0.4).cgColor)
                        
                        // Draw overlay for areas outside the visible rect but inside the effective rect
                        // Top area (if needed)
                        if visibleRect.minY > effectiveRect.minY {
                            ctx.fill(CGRect(
                                x: effectiveRect.minX,
                                y: effectiveRect.minY,
                                width: effectiveRect.width,
                                height: visibleRect.minY - effectiveRect.minY
                            ))
                        }
                        
                        // Bottom area (if needed)
                        if visibleRect.maxY < effectiveRect.maxY {
                            ctx.fill(CGRect(
                                x: effectiveRect.minX,
                                y: visibleRect.maxY,
                                width: effectiveRect.width,
                                height: effectiveRect.maxY - visibleRect.maxY
                            ))
                        }
                        
                        // Left area (if needed)
                        if visibleRect.minX > effectiveRect.minX {
                            ctx.fill(CGRect(
                                x: effectiveRect.minX,
                                y: visibleRect.minY,
                                width: visibleRect.minX - effectiveRect.minX,
                                height: visibleRect.height
                            ))
                        }
                        
                        // Right area (if needed)
                        if visibleRect.maxX < effectiveRect.maxX {
                            ctx.fill(CGRect(
                                x: visibleRect.maxX,
                                y: visibleRect.minY,
                                width: effectiveRect.maxX - visibleRect.maxX,
                                height: visibleRect.height
                            ))
                        }
                        
                        // Draw white 1pt border around visible area
                        ctx.setStrokeColor(NSColor.white.cgColor)
                        ctx.setLineWidth(1.0)
                        ctx.stroke(visibleRect)
                        
                        ctx.restoreGState()
                    }
                }
                
                // Draw pagination control if there's more than one page
                if let pdfDocument = PDFKit.PDFDocument(url: url), pdfDocument.pageCount > 1 {
                    // Create a translucent background for pagination control
                    let controlHeight: CGFloat = 26
                    let controlWidth: CGFloat = 100
                    let controlY: CGFloat = 8
                    let controlX: CGFloat = (thumbSize.width - controlWidth) / 2
                    
                    // Draw background
                    ctx.saveGState()
                    ctx.setFillColor(NSColor.black.withAlphaComponent(0.5).cgColor)
                    let controlRect = CGRect(x: controlX, y: controlY, width: controlWidth, height: controlHeight)
                    let path = NSBezierPath(roundedRect: controlRect, xRadius: 6, yRadius: 6)
                    path.fill()
                    
                    // Draw page text
                    let pageText = "\(pageIndex + 1) of \(pdfDocument.pageCount)"
                    let paragraphStyle = NSMutableParagraphStyle()
                    paragraphStyle.alignment = .center
                    let attributes: [NSAttributedString.Key: Any] = [
                        .font: NSFont.systemFont(ofSize: 12),
                        .foregroundColor: NSColor.white,
                        .paragraphStyle: paragraphStyle
                    ]
                    
                    let textSize = pageText.size(withAttributes: attributes)
                    let textX = controlX + (controlWidth - textSize.width) / 2
                    let textY = controlY + (controlHeight - textSize.height) / 2
                    
                    pageText.draw(at: NSPoint(x: textX, y: textY), withAttributes: attributes)
                    
                    // Draw left arrow if not on first page
                    if pageIndex > 0 {
                        let arrowLeft = "←"
                        let arrowAttributes: [NSAttributedString.Key: Any] = [
                            .font: NSFont.systemFont(ofSize: 14, weight: .medium),
                            .foregroundColor: NSColor.white
                        ]
                        let arrowSize = arrowLeft.size(withAttributes: arrowAttributes)
                        let arrowX = controlX + 10
                        let arrowY = controlY + (controlHeight - arrowSize.height) / 2
                        arrowLeft.draw(at: NSPoint(x: arrowX, y: arrowY), withAttributes: arrowAttributes)
                    }
                    
                    // Draw right arrow if not on last page
                    if pageIndex < pdfDocument.pageCount - 1 {
                        let arrowRight = "→"
                        let arrowAttributes: [NSAttributedString.Key: Any] = [
                            .font: NSFont.systemFont(ofSize: 14, weight: .medium),
                            .foregroundColor: NSColor.white
                        ]
                        let arrowSize = arrowRight.size(withAttributes: arrowAttributes)
                        let arrowX = controlX + controlWidth - arrowSize.width - 10
                        let arrowY = controlY + (controlHeight - arrowSize.height) / 2
                        arrowRight.draw(at: NSPoint(x: arrowX, y: arrowY), withAttributes: arrowAttributes)
                    }
                    
                    ctx.restoreGState()
                }
                
                // Call completion on main thread with the result
                DispatchQueue.main.async {
                    completion(image)
                }
            }
        }
    }
}

// View extension for conditional modifiers
extension View {
    @ViewBuilder
    func `if`<Content: View>(_ condition: Bool, transform: (Self) -> Content) -> some View {
        if condition {
            transform(self)
        } else {
            self
        }
    }
}

// Add this helper for the bottom bar background:
import AppKit
struct VisualEffectView: NSViewRepresentable {
    var material: NSVisualEffectView.Material
    var blendingMode: NSVisualEffectView.BlendingMode
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blendingMode
        view.state = .active
        return view
    }
    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

// New View for each row in the popover
struct FileConflictRowView: View {
    @Binding var item: ConflictingFileItem

    var body: some View {
        HStack {
            Text(item.fileName)
                .truncationMode(.middle)
                .foregroundColor(item.isConflict ? .primary : .secondary)
                .padding(.vertical, 2)
                .background(item.isConflict && item.shouldOverwrite ? Color.yellow.opacity(0.3) : Color.clear)
                .cornerRadius(3)
            Spacer()
            if item.isConflict {
                Toggle("Overwrite", isOn: $item.shouldOverwrite)
                    .labelsHidden()
            } else {
                Toggle("Will be saved", isOn: .constant(true))
                    .labelsHidden()
                    .disabled(true)
            }
        }
    }
}

// PresetEditorView has been moved to its own file
    
// Full PresetEditorView has been moved to its own file



// PresetDropDelegate has been moved to its own file

// Add TokenButtonView back - it was accidentally removed
struct TokenButtonView: View {
    let label: String
    let action: () -> Void
    @Binding var triggerWiggle: Bool

    @State private var xOffset: CGFloat = 0 // State for horizontal offset for the shake

    var body: some View {
        Button(action: action) {
            Text(label)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
        }
        .buttonStyle(.plain) 
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(4)
        .overlay(
            RoundedRectangle(cornerRadius: 4)
                .stroke(Color.gray.opacity(0.3), lineWidth: 1)
        )
        .offset(x: xOffset) // Apply the horizontal offset
        .onChange(of: triggerWiggle) { oldValue, newValue in
            if newValue {
                // "No" shake animation sequence
                let duration = 0.07
                let shakeAmount: CGFloat = 5
                withAnimation(.easeInOut(duration: duration)) { xOffset = -shakeAmount }
                DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
                    withAnimation(.easeInOut(duration: duration)) { xOffset = shakeAmount }
                    DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
                        withAnimation(.easeInOut(duration: duration)) { xOffset = -shakeAmount / 2 } // Smaller rebound
                        DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
                            withAnimation(.easeInOut(duration: duration)) { xOffset = shakeAmount / 2 } // Smaller rebound
                            DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
                                withAnimation(.easeInOut(duration: duration * 1.5)) { xOffset = 0 } // Settle back to center
                                triggerWiggle = false // Reset the external trigger IMPORTANT: only after animation completes
                            }
                        }
                    }
                }
            }
        }
    }
}

#Preview {
    ContentView()
}

#Preview {
    ContentView()
}