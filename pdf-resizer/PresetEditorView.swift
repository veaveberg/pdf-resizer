import SwiftUI
import AppKit

// Add DropDelegate for improved drag-and-drop behavior
struct PresetDropDelegate: DropDelegate {
    let item: PaperSize
    @Binding var items: [PaperSize]
    @Binding var draggedItem: PaperSize?
    
    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }
    
    func performDrop(info: DropInfo) -> Bool {
        draggedItem = nil
        return true
    }
    
    func dropEntered(info: DropInfo) {
        guard let draggedItem = self.draggedItem else { return }
        guard draggedItem.id != item.id else { return }
        
        let from = items.firstIndex(where: { $0.id == draggedItem.id })!
        let to = items.firstIndex(where: { $0.id == item.id })!
        
        withAnimation(.easeInOut(duration: 0.2)) {
            if from != to {
                items.move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
            }
        }
    }
}

// Add a NSViewRepresentable to capture keyboard events
struct KeyEventHandler: NSViewRepresentable {
    let onKeyDown: (NSEvent) -> Bool
    
    func makeNSView(context: Context) -> KeyView {
        let view = KeyView()
        view.onKeyDown = onKeyDown
        return view
    }
    
    func updateNSView(_ nsView: KeyView, context: Context) {
        nsView.onKeyDown = onKeyDown
    }
    
    class KeyView: NSView {
        var onKeyDown: ((NSEvent) -> Bool)?
        
        override var acceptsFirstResponder: Bool { true }
        
        override func keyDown(with event: NSEvent) -> Void {
            if let handler = onKeyDown, handler(event) {
                return
            }
            super.keyDown(with: event)
        }
    }
}

struct PresetEditorView: View {
    @Binding var isPresented: Bool
    @State private var presets: [PaperSize]
    @State private var editingPreset: PaperSize?
    @State private var newPresetName: String = ""
    @State private var newPresetWidth: CGFloat = 0
    @State private var newPresetHeight: CGFloat = 0
    @State private var isNewlyCreated = false
    @State private var draggedItem: PaperSize?
    
    // Add a force refresh ID
    @State private var forceRefreshID = UUID()
    
    // Focus management
    enum Field: Hashable {
        case name
        case width
        case height
    }
    @FocusState private var focusedField: Field?
    
    // Formatter for number fields
    private let numberFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 1
        f.minimumFractionDigits = 1
        f.decimalSeparator = ","
        return f
    }()
    
    init(isPresented: Binding<Bool>) {
        self._isPresented = isPresented
        self._presets = State(initialValue: PaperSize.allPresets)
    }
    
    // Check if edits have been made
    private var hasEdits: Bool {
        // Always consider newly created presets as having edits - they need to be saved
        if isNewlyCreated {
            print("hasEdits: This is a newly created preset - returning true")
            return true
        }
        
        guard let editing = editingPreset else { return false }
        
        if let index = presets.firstIndex(where: { $0.id == editing.id }) {
            let original = presets[index]
            let widthInPoints = CGFloat.fromMillimeters(newPresetWidth)
            let heightInPoints = CGFloat.fromMillimeters(newPresetHeight)
            
            let nameChanged = original.name != newPresetName
            let widthChanged = abs(original.width - widthInPoints) > 0.1
            let heightChanged = abs(original.height - heightInPoints) > 0.1
            
            let hasChanged = nameChanged || widthChanged || heightChanged
            print("hasEdits: Name changed: \(nameChanged), Width changed: \(widthChanged), Height changed: \(heightChanged)")
            
            return hasChanged
        }
        return false
    }
    
    // Helper method to delete a preset
    private func handleDeletePreset(_ preset: PaperSize) {
        withAnimation(.easeInOut(duration: 0.2)) {
            if let index = presets.firstIndex(where: { $0.id == preset.id }) {
                presets.remove(at: index)
                PaperSize.deleteCustomPreset(id: preset.id)
                
                // If we were editing this preset, close the editor
                if editingPreset?.id == preset.id {
                    editingPreset = nil
                    focusedField = nil
                }
            }
        }
    }
    
    // Save updated presets back to storage
    private func saveChanges() {
        print("--- saveChanges called ---")
        
        // We should not directly overwrite customPresets property
        // Instead, just sync visibility settings for built-in presets
        
        // For built-ins, we only care about visibility
        // This is already handled by toggleVisibility method
        
        // For custom presets, individual save/update operations should be 
        // handled by addCustomPreset and updateCustomPreset methods
        
        // Force a synchronize to ensure data is saved immediately
        UserDefaults.standard.synchronize()
        print("--- UserDefaults synchronized in saveChanges ---")
    }
    
    // Helper method to refresh presets data and force UI update
    private func refreshPresets() {
        print("Refreshing presets list from storage")
        
        // Force UserDefaults to synchronize to ensure we have the latest data
        UserDefaults.standard.synchronize()
        
        // Create a temporary array to force SwiftUI to see this as a new array
        let tempPresets = PaperSize.allPresets
        
        // Reset the array to force a complete UI refresh
        presets = []
        
        // Use a tiny delay then update with the new presets to force a complete redraw
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) {
            print("Setting \(tempPresets.count) presets")
            self.presets = tempPresets
            self.forceRefreshID = UUID() // Generate new ID to force view update
        }
    }
    
    // Helper method to save a preset
    private func handleSavePreset(_ preset: PaperSize) {
        print("\n=== HANDLE SAVE PRESET CALLED ===")
        
        // Get width and height in points
        let widthInPoints = CGFloat.fromMillimeters(newPresetWidth)
        let heightInPoints = CGFloat.fromMillimeters(newPresetHeight)
        
        // Flag to track if we made changes
        var presetUpdated = false
        
        // The preset we'll save/update
        var updatedPreset: PaperSize
        
        if isNewlyCreated {
            // For new presets, create a new custom preset with the same ID
            updatedPreset = PaperSize(
                id: preset.id,
                name: newPresetName,
                width: widthInPoints,
                height: heightInPoints,
                isBuiltIn: false,
                isHidden: false
            )
            
            // Add to storage
            PaperSize.addCustomPreset(updatedPreset)
            print("Added new preset: \(updatedPreset.name)")
            presetUpdated = true
        }
        else if preset.isBuiltIn {
            // For built-ins, create a new custom preset
            updatedPreset = PaperSize(
                name: newPresetName,
                width: widthInPoints,
                height: heightInPoints,
                isBuiltIn: false
            )
            
            // Add to storage
            PaperSize.addCustomPreset(updatedPreset)
            print("Added custom preset from built-in: \(updatedPreset.name)")
            presetUpdated = true
        }
        else {
            // Update existing custom preset
            updatedPreset = PaperSize(
                id: preset.id,
                name: newPresetName,
                width: widthInPoints,
                height: heightInPoints,
                isBuiltIn: false
            )
            
            // Update in storage
            PaperSize.updateCustomPreset(updatedPreset)
            print("Updated existing preset: \(updatedPreset.name)")
            presetUpdated = true
        }
        
        // Force UserDefaults to synchronize
        UserDefaults.standard.synchronize()
        
        // Close the editing view
        editingPreset = nil
        focusedField = nil
        
        // IMPORTANT: Force an immediate complete update of the preset list
        presets = []
        DispatchQueue.main.async {
            self.presets = PaperSize.allPresets
            
            // Ensure UserDefaults is synchronized
            UserDefaults.standard.synchronize()
        }
        
        // Post notification for preset changes
        if presetUpdated {
            NotificationCenter.default.post(name: NSNotification.Name("PresetListChanged"), object: nil)
        }
    }
    
    // MARK: - View Components
    
    // Render a preset row
    @ViewBuilder
    private func presetRowView(preset: PaperSize) -> some View {
        VStack(spacing: 0) {
            // Main preset row - make button cover the entire area with contentShape
            Button(action: {
                withAnimation(.easeInOut(duration: 0.2)) {
                    // For built-in presets, don't allow editing
                    if preset.isBuiltIn {
                        return
                    }
                    
                    if editingPreset?.id == preset.id {
                        // Already editing - close it
                        editingPreset = nil
                        focusedField = nil
                    } else {
                        // Start editing this preset
                        editingPreset = preset
                        isNewlyCreated = false
                        newPresetName = preset.name
                        newPresetWidth = preset.width.toMillimeters
                        newPresetHeight = preset.height.toMillimeters
                        
                        // Set focus to name field after a brief delay
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            focusedField = .name
                        }
                    }
                }
            }) {
                HStack {
                    // Name - switches between text and text field
                    Group {
                        if editingPreset?.id == preset.id {
                            TextField("Name", text: $newPresetName)
                                .textFieldStyle(.roundedBorder)
                                .focused($focusedField, equals: .name)
                                .submitLabel(.next)
                                .onSubmit {
                                    if hasEdits {
                                        // Try to save when Enter is pressed
                                        handleSavePreset(preset)
                                    } else {
                                        // Otherwise just move to next field
                                        focusedField = .width
                                    }
                                }
                                .onChange(of: focusedField) { oldValue, newValue in
                                    if oldValue == .name && newValue == nil {
                                        DispatchQueue.main.async {
                                            focusedField = .width
                                        }
                                    }
                                }
                        } else {
                            Text(preset.name)
                                .fontWeight(.medium)
                                .foregroundColor(PaperSize.isPresetHidden(id: preset.id) ? .secondary : .primary)
                        }
                    }
                    
                    // Dimensions - only visible when not editing
                    if editingPreset?.id != preset.id {
                        Text("\(Int(preset.width.toMillimeters))×\(Int(preset.height.toMillimeters))")
                            .foregroundColor(.secondary)
                    }
                    
                    Spacer()
                    
                    // Only show visibility toggle/delete for non-editing state
                    if editingPreset?.id != preset.id {
                        // Visibility toggle button (eye icon)
                        Button(action: {
                            // Toggle visibility state directly
                            let isHidden = PaperSize.isPresetHidden(id: preset.id)
                            print("Toggling visibility for preset \(preset.name), current hidden state: \(isHidden)")
                            
                            // Toggle the visibility state
                            PaperSize.toggleVisibility(id: preset.id)
                            
                            // Force a UI update by refreshing the entire presets list with a delay to ensure UserDefaults is updated
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                                // Use our utility function to refresh presets
                                self.refreshPresets()
                                
                                print("After toggle, refreshed presets list, hidden state for \(preset.name): \(PaperSize.isPresetHidden(id: preset.id))")
                            }
                        }) {
                            Image(systemName: PaperSize.isPresetHidden(id: preset.id) ? "eye.slash.fill" : "eye.fill")
                                .foregroundColor(PaperSize.isPresetHidden(id: preset.id) ? .secondary : .accentColor)
                                .frame(width: 30, height: 30)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        
                        // Trash button - only for custom presets
                        if !preset.isBuiltIn {
                            Button(action: {
                                // Handle deletion
                                handleDeletePreset(preset)
                            }) {
                                Image(systemName: "trash")
                                    .foregroundColor(.red)
                                    .frame(width: 30, height: 30)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        
                        // Chevron indicator (only for custom presets)
                        if !preset.isBuiltIn {
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
            .buttonStyle(PlainButtonStyle()) // Ensure no button styling
            .contentShape(Rectangle()) // Cover the entire area
            .padding(.vertical, 4) // Make rows narrower
            
            // Edit section - only visible when editing this preset
            if editingPreset?.id == preset.id {
                editSectionView(preset: preset)
            }
        }
        .background(Color(NSColor.controlBackgroundColor).opacity(editingPreset?.id == preset.id ? 0.5 : 0))
        .opacity(PaperSize.isPresetHidden(id: preset.id) && editingPreset?.id != preset.id ? 0.6 : 1.0) // Dim hidden presets when not editing
        .cornerRadius(8)
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .id("\(preset.id.uuidString)-\(preset.name)-\(preset.width)-\(preset.height)-\(PaperSize.isPresetHidden(id: preset.id))-\(forceRefreshID.uuidString)")  // More comprehensive ID pattern
        .onDrag {
            self.draggedItem = preset
            return NSItemProvider(object: preset.id.uuidString as NSString)
        }
        .onDrop(of: [.text], delegate: PresetDropDelegate(item: preset, items: $presets, draggedItem: $draggedItem))
    }
    
    // Edit section view for a preset
    @ViewBuilder
    private func editSectionView(preset: PaperSize) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // Width and height fields
            HStack(spacing: 8) {
                Text("Width:")
                StepperTextField(
                    value: $newPresetWidth,
                    formatter: numberFormatter,
                    minValue: 1,
                    maxValue: nil
                )
                .focused($focusedField, equals: .width)
                .frame(width: 60, height: 24)
                .onSubmit {
                    if hasEdits {
                        // Try to save if edits are present
                        handleSavePreset(preset)
                    } else {
                        // Otherwise move to height field
                        focusedField = .height
                    }
                }
                .onExitCommand {
                    focusedField = .height
                }
                
                Text("Height:")
                StepperTextField(
                    value: $newPresetHeight,
                    formatter: numberFormatter,
                    minValue: 1,
                    maxValue: nil
                )
                .focused($focusedField, equals: .height)
                .frame(width: 60, height: 24)
                .onSubmit {
                    // When Enter is pressed in height field, save if possible
                    if hasEdits {
                        handleSavePreset(preset)
                    }
                }
                .onExitCommand {
                    // Focus will naturally move to the next focusable item
                }
                
                Spacer()
            }
            
            HStack {
                Spacer()
                Button("Cancel") {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if isNewlyCreated {
                            // Remove newly created preset if canceled
                            if let index = presets.firstIndex(where: { $0.id == preset.id }) {
                                presets.remove(at: index)
                            }
                        }
                        
                        // Save visibility changes even when canceling edits
                        saveChanges()
                        
                        editingPreset = nil
                        focusedField = nil
                    }
                }
                // Remove keyboard shortcut and use onSubmit directly
                
                Button("Save") {
                    // Debug print to see what values we're saving
                    print("=============================================")
                    print("SAVE BUTTON PRESSED")
                    print("hasEdits = \(hasEdits)")
                    print("newPresetName = \(newPresetName)")
                    print("newPresetWidth = \(newPresetWidth)mm")
                    print("newPresetHeight = \(newPresetHeight)mm")
                    print("isNewlyCreated = \(isNewlyCreated)")
                    if let editing = editingPreset {
                        print("editingPreset: id=\(editing.id), name=\(editing.name)")
                    } else {
                        print("editingPreset: nil")
                    }
                    print("=============================================")
                    
                    // Handle saving the preset
                    handleSavePreset(preset)
                }
                .disabled(!hasEdits)
            }
            .padding(.top, 4)
        }
        .padding(.bottom, 8)
        .padding(.horizontal, 8)
        .transition(.opacity)
    }
    
    // "Add new preset" button view
    @ViewBuilder
    private func addNewPresetButton() -> some View {
        HStack {
            Spacer()
            Button(action: {
                withAnimation(.easeInOut(duration: 0.2)) {
                    // Generate a unique name starting with "New Preset"
                    var newPresetName = "New Preset"
                    var counter = 2
                    
                    // Check if the name already exists and increment if needed
                    while presets.contains(where: { $0.name == newPresetName }) {
                        newPresetName = "New Preset \(counter)"
                        counter += 1
                    }
                    
                    // Create a proper new UUID for this preset
                    let uniqueId = UUID()
                    print("Creating new preset with unique ID: \(uniqueId)")
                    
                    let newPreset = PaperSize(
                        id: uniqueId, // Explicitly set a new UUID
                        name: newPresetName,
                        width: 595, // A4 width in points
                        height: 842, // A4 height in points,
                        isBuiltIn: false // Make sure it's not built-in
                    )
                    
                    // Log the new preset for debugging
                    print("Created new preset: id=\(newPreset.id), name=\(newPreset.name)")
                    
                    // Add to presets array temporarily for UI display
                    presets.append(newPreset)
                    
                    // Start editing the new preset immediately
                    editingPreset = newPreset
                    isNewlyCreated = true
                    self.newPresetName = newPreset.name
                    newPresetWidth = newPreset.width.toMillimeters
                    newPresetHeight = newPreset.height.toMillimeters
                    
                    // Focus on the name field after a brief delay
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        focusedField = .name
                    }
                }
            }) {
                Image(systemName: "plus.square")
                    .font(.system(size: 28))
                    .foregroundColor(.accentColor)
            }
            .buttonStyle(.plain)
            .padding()
            Spacer()
        }
    }
    
    // Main view body
    var body: some View {
        ZStack {
            // Background overlay to detect clicks outside the main content
            Color.black.opacity(0.001) // Nearly invisible
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .onTapGesture {
                    saveChanges()
                    isPresented = false
                }
                
            VStack(spacing: 0) {
                // Header with title and done button
                HStack {
                    Text("Paper Size Presets")
                        .font(.headline)
                    Spacer()
                    
                    Button("Done") {
                        saveChanges()
                        isPresented = false
                    }
                    // Disable auto-focus for the button
                    .buttonStyle(BorderlessButtonStyle())
                }
                .padding(.horizontal)
                .padding(.top)
                .padding(.bottom, 8)
                
                Divider()
            
                // Preset list
                List {
                    // Presets
                    ForEach(presets) { preset in
                        presetRowView(preset: preset)
                    }
                    
                    // Add new preset button
                    addNewPresetButton()
                }
                .listStyle(.plain)
                .id(forceRefreshID)  // Force List to refresh when this ID changes
            }
            .frame(width: 400, height: 500)
            // Add a key event handler to capture Enter key presses for saving
            .background(
                KeyEventHandler { event in
                    // Check if it's an Enter/Return key press
                    if event.keyCode == 36 || event.keyCode == 76 {
                        // Check if we have an editing preset with changes
                        if let preset = editingPreset, hasEdits {
                            handleSavePreset(preset)
                            return true
                        }
                    }
                    return false
                }
                .frame(width: 0, height: 0)
            )
            .onAppear {
                // Make sure our preset list has the latest from UserDefaults
                print("PresetEditorView appeared - refreshing presets from storage")
                
                // Reset the preset list to ensure a complete refresh
                presets = []
                
                // Force UserDefaults synchronization
                UserDefaults.standard.synchronize()
                
                // Use a delay to ensure the UI is ready
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    // Use our utility function to refresh presets
                    self.refreshPresets()
                }
                
                // Add observer for preset visibility changes
                NotificationCenter.default.addObserver(forName: NSNotification.Name("PresetVisibilityChanged"), 
                                                      object: nil, 
                                                      queue: .main) { _ in
                    // Reload presets and force UI update
                    print("PresetEditorView received visibility change notification")
                    self.refreshPresets()
                }
            }
            .background(Color.clear) // Needed for the ZStack tap detection to work properly
        }
    }
} 