import SwiftUI // For UTType, FileDocument etc.
import CoreGraphics // For CGSize
import UniformTypeIdentifiers // For UTType

enum ResizeMode {
    case fillSize
    case fitWidth
    case fitHeight
}

// Paper size presets in points (1 point = 1/72 inch)
struct PaperSize: Identifiable, Equatable {
    let id: UUID
    var name: String
    var width: CGFloat // in points
    var height: CGFloat // in points
    var isBuiltIn: Bool // Flag to distinguish built-in vs custom presets
    var isHidden: Bool = false // Flag to track if the preset is hidden from dropdown
    
    init(id: UUID = UUID(), name: String, width: CGFloat, height: CGFloat, isBuiltIn: Bool = true, isHidden: Bool = false) {
        self.id = id
        self.name = name
        self.width = width
        self.height = height
        self.isBuiltIn = isBuiltIn
        self.isHidden = isHidden
    }
    
    // Ensure width is always the smaller dimension (portrait orientation)
    // This makes it easier to rotate based on PDF dimensions
    var standardized: (width: CGFloat, height: CGFloat) {
        return width <= height ? (width, height) : (height, width)
    }
    
    // Standard ISO A series paper sizes (in points @ 72dpi)
    static let a0 = PaperSize(name: "A0", width: 2384, height: 3370)
    static let a1 = PaperSize(name: "A1", width: 1684, height: 2384)
    static let a2 = PaperSize(name: "A2", width: 1191, height: 1684)
    static let a3 = PaperSize(name: "A3", width: 842, height: 1191)
    static let a4 = PaperSize(name: "A4", width: 595, height: 842)
    static let a5 = PaperSize(name: "A5", width: 420, height: 595)
    
    // Standard presets for the dropdown menu (read-only)
    static let standardPresets: [PaperSize] = [
        a0, a1, a2, a3, a4, a5
    ]
    
    // UserDefaults key for storing custom presets
    private static let customPresetsKey = "PDFResizer.CustomPaperSizes"
    
    // Custom user-created presets (stored in UserDefaults)
    static var customPresets: [PaperSize] {
        get {
            if let data = UserDefaults.standard.data(forKey: customPresetsKey) {
                do {
                    let decoded = try JSONDecoder().decode([CustomPaperSize].self, from: data)
                    return decoded.map { 
                        PaperSize(id: UUID(uuidString: $0.id) ?? UUID(), 
                                 name: $0.name, 
                                 width: $0.width, 
                                 height: $0.height, 
                                 isBuiltIn: false,
                                 isHidden: $0.isHidden)
                    }
                } catch {
                    print("Error decoding custom paper sizes: \(error)")
                    return []
                }
            }
            return []
        }
        set {
            let customOnly = newValue.filter { !$0.isBuiltIn }
            let toEncode = customOnly.map { 
                CustomPaperSize(id: $0.id.uuidString, name: $0.name, width: $0.width, height: $0.height, isHidden: $0.isHidden)
            }
            
            do {
                let data = try JSONEncoder().encode(toEncode)
                UserDefaults.standard.set(data, forKey: customPresetsKey)
            } catch {
                print("Error encoding custom paper sizes: \(error)")
            }
        }
    }
    
    // Add a custom preset
    static func addCustomPreset(_ preset: PaperSize) {
        print("Adding custom preset: id=\(preset.id), name=\(preset.name), width=\(preset.width), height=\(preset.height)")
        
        // Fetch the current custom presets
        var current = customPresets
        
        // Check if a preset with this ID already exists
        if let existingIndex = current.firstIndex(where: { $0.id == preset.id }) {
            print("Found existing preset with same ID - updating instead of adding")
            // Update the existing preset instead of adding a duplicate
            current[existingIndex] = preset
        } else {
            // Create a new PaperSize instance to ensure consistency
            let newPreset = PaperSize(
                id: preset.id, // Keep the provided ID to maintain UI references
                name: preset.name,
                width: preset.width,
                height: preset.height,
                isBuiltIn: false, // Custom presets are never built-in
                isHidden: preset.isHidden
            )
            
            // Add the new preset to the list
            current.append(newPreset)
            print("Added new preset with ID: \(newPreset.id)")
        }
        
        // Save the updated list back to storage
        customPresets = current
        
        // Force immediate persistence
        UserDefaults.standard.synchronize()
        
        // Notify about preset list change
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: NSNotification.Name("PresetListChanged"), object: nil)
        }
    }
    
    // Update a custom preset
    static func updateCustomPreset(_ preset: PaperSize) {
        print("Updating custom preset: id=\(preset.id), name=\(preset.name), width=\(preset.width), height=\(preset.height)")
        
        // Fetch the current custom presets
        var current = customPresets
        
        // Try to find the preset with the same ID
        if let index = current.firstIndex(where: { $0.id == preset.id }) {
            print("Found existing preset at index \(index), updating")
            current[index] = preset
            
            // Save the updated list back to storage
            customPresets = current
            
            // Force immediate persistence
            UserDefaults.standard.synchronize()
            print("Updated preset in storage and synchronized UserDefaults")
            
            // Notify about preset list change
            DispatchQueue.main.async {
                print("Broadcasting PresetListChanged notification")
                NotificationCenter.default.post(name: NSNotification.Name("PresetListChanged"), object: nil)
            }
        } else {
            print("Warning: Could not find preset with ID \(preset.id) to update. Adding it instead.")
            // Fall back to adding it if not found
            addCustomPreset(preset)
        }
    }
    
    // Delete a custom preset
    static func deleteCustomPreset(id: UUID) {
        print("Deleting custom preset with ID: \(id)")
        var current = customPresets
        current.removeAll(where: { $0.id == id })
        customPresets = current
        
        // Notify about preset list change
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: NSNotification.Name("PresetListChanged"), object: nil)
        }
    }
    
    // Get all presets (standard + custom)
    static var allPresets: [PaperSize] {
        var allPresets = standardPresets
        allPresets.append(contentsOf: customPresets)
        return allPresets
    }
    
    // Function to restore missing default presets
    static func restoreMissingDefaults() -> Int {
        // Get current presets to check what's missing
        let currentPresets = allPresets
        
        // Standard preset names for comparison
        let standardNames = Set(standardPresets.map { $0.name })
        // Current preset names
        let currentNames = Set(currentPresets.map { $0.name })
        
        // Find which standard presets are missing
        let missingNames = standardNames.subtracting(currentNames)
        
        // If nothing is missing, return 0
        if missingNames.isEmpty {
            return 0
        }
        
        // Find and add the missing presets
        let missingPresets = standardPresets.filter { missingNames.contains($0.name) }
        
        for preset in missingPresets {
            // For built-in presets, we need to add a copy with isBuiltIn=true
            let restoredPreset = PaperSize(
                name: preset.name,
                width: preset.width,
                height: preset.height,
                isBuiltIn: true // Ensure it's flagged as built-in
            )
            
            // We'll temporarily use addCustomPreset, but we need to make sure to mark it as built-in
            // Add to UserDefaults by adding to our custom list (it's a built-in but must be stored)
            var current = customPresets
            current.append(restoredPreset)
            customPresets = current
        }
        
        return missingPresets.count
    }
    
    // Set visibility for a preset
    static func toggleVisibility(id: UUID) {
        // Debug output to track what's happening
        print("toggleVisibility called for preset ID: \(id)")
        
        // First, check if it's a built-in preset (using standardPresets)
        let hiddenBuiltInKey = "PDFResizer.HiddenBuiltInPresets"
        var hiddenBuiltInIds = Set<String>()
        
        // Load existing hidden built-in IDs
        if let savedData = UserDefaults.standard.object(forKey: hiddenBuiltInKey) as? [String] {
            hiddenBuiltInIds = Set(savedData)
            print("Existing hidden built-in IDs: \(hiddenBuiltInIds)")
        }
        
        // Find if we're toggling a built-in preset
        let isBuiltIn = standardPresets.contains(where: { $0.id == id })
        print("Is this a built-in preset? \(isBuiltIn)")
        
        var visibilityChanged = false
        
        if isBuiltIn {
            let stringId = id.uuidString
            if hiddenBuiltInIds.contains(stringId) {
                hiddenBuiltInIds.remove(stringId)
                print("Removed from hidden list: \(stringId)")
                visibilityChanged = true
            } else {
                hiddenBuiltInIds.insert(stringId)
                print("Added to hidden list: \(stringId)")
                visibilityChanged = true
            }
            
            // Save back to UserDefaults
            UserDefaults.standard.set(Array(hiddenBuiltInIds), forKey: hiddenBuiltInKey)
            // Force immediate synchronization to ensure data is written
            UserDefaults.standard.synchronize()
            print("Saved built-in hidden state to UserDefaults and synchronized")
        } else {
            // If we got here, it's a custom preset
            var current = customPresets
            if let index = current.firstIndex(where: { $0.id == id }) {
                // Toggle visibility state
                current[index].isHidden.toggle()
                let newState = current[index].isHidden
                print("Toggled custom preset hidden state to: \(newState)")
                
                // Save and synchronize
                customPresets = current
                UserDefaults.standard.synchronize()
                print("Updated custom presets and synchronized UserDefaults")
                visibilityChanged = true
            } else {
                print("Could not find custom preset with ID: \(id)")
            }
        }
        
        // Post notification about preset visibility change
        if visibilityChanged {
            print("Posting PresetVisibilityChanged notification")
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: NSNotification.Name("PresetVisibilityChanged"), object: nil)
                print("PresetVisibilityChanged notification posted")
            }
        } else {
            print("No visibility changes made - skipping notification")
        }
    }
    
    // Function to check if a preset is hidden
    static func isPresetHidden(id: UUID) -> Bool {
        // Check if it's a built-in preset first
        let isBuiltIn = standardPresets.contains(where: { $0.id == id })
        
        if isBuiltIn {
            // Check against the hidden built-in list
            let hiddenBuiltInKey = "PDFResizer.HiddenBuiltInPresets"
            // Make sure we have the latest data from UserDefaults
            if let hiddenIds = UserDefaults.standard.object(forKey: hiddenBuiltInKey) as? [String] {
                let result = hiddenIds.contains(id.uuidString)
                return result
            }
            return false
        }
        
        // Then check custom presets - fetch fresh data directly from UserDefaults
        // This is to avoid any potential caching issues with the customPresets computed property
        if let data = UserDefaults.standard.data(forKey: customPresetsKey),
           let decoded = try? JSONDecoder().decode([CustomPaperSize].self, from: data),
           let preset = decoded.first(where: { UUID(uuidString: $0.id) == id }) {
            return preset.isHidden
        }
        
        return false
    }
    
    // Get all presets that are visible (not hidden) for dropdown
    static var visiblePresets: [PaperSize] {
        // This is a computed property that should always return fresh data
        // It's called whenever UI needs to display the presets dropdown
        print("Getting visiblePresets - filtering out hidden items")
        return allPresets.filter { !isPresetHidden(id: $0.id) }
    }
    
    // Helper struct for JSON encoding/decoding
    private struct CustomPaperSize: Codable {
        let id: String
        let name: String
        let width: CGFloat
        let height: CGFloat
        let isHidden: Bool
    }
    
    // Required for Equatable
    static func == (lhs: PaperSize, rhs: PaperSize) -> Bool {
        return lhs.id == rhs.id
    }
}

struct SizeAdjuster: Identifiable, Equatable {
    let id: UUID
    var resizeMode: ResizeMode
    var targetSize: CGSize // Stored in points
    
    // Default A4 size in points (595×842 points at 72dpi = 210×297mm)
    static let defaultA4Size = CGSize(width: 595, height: 842)

    init(id: UUID = UUID(), resizeMode: ResizeMode = .fillSize, targetSize: CGSize = SizeAdjuster.defaultA4Size) {
        self.id = id
        self.resizeMode = resizeMode
        self.targetSize = targetSize
    }
    
    // Used for making a copy with a new ID
    func copyWithNewID() -> SizeAdjuster {
        return SizeAdjuster(id: UUID(), resizeMode: self.resizeMode, targetSize: self.targetSize)
    }
}

struct PDFDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.pdf] }

    var data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.data = data
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        return FileWrapper(regularFileWithContents: data)
    }
} 