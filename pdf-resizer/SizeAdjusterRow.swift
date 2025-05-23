import SwiftUI

struct SizeAdjusterRow: View {
    let adjuster: SizeAdjuster
    @Binding var sizeAdjusters: [SizeAdjuster]
    let numberFormatter: NumberFormatter
    @FocusState.Binding var focusedField: FieldFocus?
    let resultingSize: CGSize
    let aspectRatio: CGFloat?

    @State private var editingWidth: CGFloat?
    @State private var editingHeight: CGFloat?
    @State private var showingPresetEditor = false
    
    // Store the adjuster ID to detect changes
    @State private var lastAdjusterID: UUID = UUID()
    
    // Add a state to force refresh the presets dropdown
    @State private var presetsRefreshID = UUID()
    
    // Add a state to store the current visible presets
    @State private var currentVisiblePresets: [PaperSize] = PaperSize.visiblePresets

    private var widthBinding: Binding<CGFloat> {
        Binding<CGFloat>(
            get: {
                editingWidth ?? adjuster.targetSize.width.toMillimeters
            },
            set: { newValue in
                editingWidth = newValue
                if let idx = sizeAdjusters.firstIndex(where: { $0.id == adjuster.id }) {
                    sizeAdjusters[idx].targetSize.width = CGFloat.fromMillimeters(newValue)
                }
            }
        )
    }
    private var heightBinding: Binding<CGFloat> {
        Binding<CGFloat>(
            get: {
                editingHeight ?? adjuster.targetSize.height.toMillimeters
            },
            set: { newValue in
                editingHeight = newValue
                if let idx = sizeAdjusters.firstIndex(where: { $0.id == adjuster.id }) {
                    sizeAdjusters[idx].targetSize.height = CGFloat.fromMillimeters(newValue)
                }
            }
        )
    }

    private func liveResultingSize() -> CGSize { // Output is in points
        // `currentWidthInPoints` and `currentHeightInPoints` reflect the current values,
        // either from active editing (via editingWidth/Height state) or the underlying model (adjuster.targetSize).
        let currentWidthInPoints = editingWidth != nil ? CGFloat.fromMillimeters(editingWidth!) : adjuster.targetSize.width
        let currentHeightInPoints = editingHeight != nil ? CGFloat.fromMillimeters(editingHeight!) : adjuster.targetSize.height

        // We need to ensure we use the correct aspect ratio that accounts for bleed trimming
        // The aspectRatio provided to this component already accounts for trimming when needed
        // (it comes from the parent ContentView which passes in the correct value)
        let ar = aspectRatio ?? 1.0 // Default to 1.0 if PDF not loaded or has no aspect ratio

        switch adjuster.resizeMode {
        case .fillSize:
            // Both width and height are directly driven by user input.
            return CGSize(width: currentWidthInPoints, height: currentHeightInPoints)
        case .fitWidth: // UI: "Set Height". User actively sets HEIGHT. Width is calculated.
            // Authoritative input for this mode is currentHeightInPoints.
            let calculatedWidth = currentHeightInPoints * ar
            return CGSize(width: calculatedWidth, height: currentHeightInPoints)
        case .fitHeight: // UI: "Set Width". User actively sets WIDTH. Height is calculated.
            // Authoritative input for this mode is currentWidthInPoints.
            let calculatedHeight = (ar != 0) ? (currentWidthInPoints / ar) : 0 // Avoid division by zero
            return CGSize(width: currentWidthInPoints, height: calculatedHeight)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(spacing: 0) {
                VStack(alignment: .center, spacing: 15) {
                    HStack(spacing: 10) {
                        // Presets Menu
                        Menu {
                            ForEach(PaperSize.visiblePresets) { preset in
                                Button(action: {
                                    applyPreset(preset)
                                }) {
                                    Text(preset.name)
                                }
                            }
                            .id(presetsRefreshID) // Force menu to update when this ID changes
                            
                            Divider()
                            
                            Button("Edit...") {
                                showingPresetEditor = true
                            }
                        } label: {
                            Text("Presets")
                                .lineLimit(1)
                                .truncationMode(.tail)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(Color(NSColor.controlBackgroundColor))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 4)
                                    .stroke(Color.gray.opacity(0.3), lineWidth: 0.5)
                            )
                        }
                        .frame(width: 90, alignment: .leading)
                        
                        // Resize Mode Picker
                        Picker("", selection: Binding(
                            get: {
                                print("Picker GET for adjuster \(adjuster.id): mode is \(adjuster.resizeMode)") // DEBUG
                                return adjuster.resizeMode
                            },
                            set: { newValue in
                                print("Picker SET for adjuster \(adjuster.id): new mode is \(newValue)") // DEBUG
                                // Clear any active text field focus when segment control is changed
                                focusedField = nil
                                
                                if let idx = sizeAdjusters.firstIndex(where: { $0.id == adjuster.id }) {
                                    // Also reset the editing state variables to ensure clean update
                                    editingWidth = nil
                                    editingHeight = nil
                                    
                                    sizeAdjusters[idx].resizeMode = newValue
                                    print("Updated sizeAdjusters[\(idx)].resizeMode to \(sizeAdjusters[idx].resizeMode) for ID \(adjuster.id)") // DEBUG
                                }
                            })
                        ) {
                            Text("Fill").tag(ResizeMode.fillSize)
                            Text("Set Width").tag(ResizeMode.fitHeight)
                            Text("Set Height").tag(ResizeMode.fitWidth)
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: .infinity)
                    }
                    VStack(alignment: .center, spacing: 10) {
                        HStack(spacing: 8) {
                            Text("Width:")
                            if adjuster.resizeMode == .fitWidth {
                                let liveSize = liveResultingSize()
                                Text("\(numberFormatter.string(from: NSNumber(value: Double(liveSize.width.toMillimeters))) ?? "")")
                                    .frame(width: 60, alignment: .trailing)
                                    .foregroundColor(.secondary)
                                    .padding(.trailing, 4)
                                    .id(liveSize.width)
                                    .transition(.opacity)
                                    .animation(.easeInOut, value: liveSize.width)
                            } else {
                                StepperTextField(
                                    value: widthBinding,
                                    formatter: numberFormatter,
                                    minValue: 1,
                                    maxValue: nil
                                )
                                .frame(width: 60)
                                .focused($focusedField, equals: .width(adjuster.id))
                            }
                            Button(action: {
                                // 1. Determine current logical width/height in mm (what user sees)
                                let logicalCurrentWidthMm = editingWidth ?? adjuster.targetSize.width.toMillimeters
                                let logicalCurrentHeightMm = editingHeight ?? adjuster.targetSize.height.toMillimeters

                                // 2. Update @State editing values to swapped logical values
                                editingWidth = logicalCurrentHeightMm
                                editingHeight = logicalCurrentWidthMm

                                // 3. Update the model in sizeAdjusters array (in points)
                                if let idx = sizeAdjusters.firstIndex(where: { $0.id == adjuster.id }) {
                                    sizeAdjusters[idx].targetSize.width = CGFloat.fromMillimeters(logicalCurrentHeightMm)
                                    sizeAdjusters[idx].targetSize.height = CGFloat.fromMillimeters(logicalCurrentWidthMm)
                                }
                            }) {
                                Image(systemName: "arrow.left.arrow.right")
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .opacity(adjuster.resizeMode == .fillSize ? 1 : 0)
                            Text("Height:")
                            if adjuster.resizeMode == .fitHeight {
                                let liveSize = liveResultingSize()
                                Text("\(numberFormatter.string(from: NSNumber(value: Double(liveSize.height.toMillimeters))) ?? "")")
                                    .frame(width: 60, alignment: .trailing)
                                    .foregroundColor(.secondary)
                                    .padding(.trailing, 4)
                                    .id(liveSize.height)
                                    .transition(.opacity)
                                    .animation(.easeInOut, value: liveSize.height)
                            } else {
                                StepperTextField(
                                    value: heightBinding,
                                    formatter: numberFormatter,
                                    minValue: 1,
                                    maxValue: nil
                                )
                                .frame(width: 60)
                                .focused($focusedField, equals: .height(adjuster.id))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .padding(18)
            }
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(NSColor.controlBackgroundColor))
                    .shadow(color: Color.black.opacity(0.06), radius: 8, x: 0, y: 2)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.gray.opacity(0.13), lineWidth: 1)
            )
            .frame(maxWidth: 370)
            if sizeAdjusters.count > 1 {
                Button(action: {
                    withAnimation {
                        if let idx = sizeAdjusters.firstIndex(where: { $0.id == adjuster.id }) {
                            sizeAdjusters.remove(at: idx)
                        }
                    }
                }) {
                    Image(systemName: "minus.circle.fill")
                        .foregroundColor(.red)
                        .imageScale(.large)
                }
                .buttonStyle(.plain)
                            .padding(.top, 12)
        }
    }
    .onAppear {
        // Initialize the lastAdjusterID to detect future changes
        lastAdjusterID = adjuster.id
        
        // Reset editing values to match the current adjuster when the view appears
        editingWidth = nil
        editingHeight = nil
        
        // Initialize visible presets
        currentVisiblePresets = PaperSize.visiblePresets
        
        // Setup notification center observers
        let notificationCenter = NotificationCenter.default
        
        // Add observer for preset visibility changes
        notificationCenter.addObserver(forName: NSNotification.Name("PresetVisibilityChanged"), 
                                      object: nil, 
                                      queue: .main) { _ in
            // Refresh visible presets list from source
            print("SizeAdjusterRow received visibility change notification - updating presets list")
            self.currentVisiblePresets = PaperSize.visiblePresets
            
            // Update ID to force refresh the menu
            self.presetsRefreshID = UUID()
        }
        
        // Add observer for preset list changes (additions/updates)
        notificationCenter.addObserver(forName: NSNotification.Name("PresetListChanged"), 
                                      object: nil, 
                                      queue: .main) { _ in
            print("SizeAdjusterRow received PresetListChanged notification")
            // Update visible presets list from source
            self.currentVisiblePresets = PaperSize.visiblePresets
            
            // Update ID to force refresh the menu with new presets
            self.presetsRefreshID = UUID()
        }
    }
    .onChange(of: adjuster.id) { oldID, newID in
        if oldID != newID {
            // Reset editing values when adjuster changes
            editingWidth = nil
            editingHeight = nil
            lastAdjusterID = newID
        }
    }
                    .onChange(of: adjuster.targetSize) { oldSize, newSize in
                    // Reset editing values when target size changes dramatically
                    // Only reset if the user isn't actively editing
                    if focusedField != .width(adjuster.id) && focusedField != .height(adjuster.id) {
                        editingWidth = nil
                        editingHeight = nil
                    }
                }
                .sheet(isPresented: $showingPresetEditor) {
                    PresetEditorView(isPresented: $showingPresetEditor)
                }
}

    // Apply the selected paper size preset with automatic orientation detection
    private func applyPreset(_ preset: PaperSize) {
        // Clear focus from any fields
        focusedField = nil
        
        // Reset editing state
        editingWidth = nil
        editingHeight = nil
        
        // Update the size adjuster in the array
        if let idx = sizeAdjusters.firstIndex(where: { $0.id == adjuster.id }) {
            var updatedAdjuster = sizeAdjusters[idx]
            
            // Determine the orientation based on the current PDF's aspect ratio
            if let ar = aspectRatio {
                // If PDF is wider than tall (landscape), use horizontal orientation
                let isLandscape = ar > 1.0
                let targetWidth = isLandscape ? max(preset.width, preset.height) : min(preset.width, preset.height)
                let targetHeight = isLandscape ? min(preset.width, preset.height) : max(preset.width, preset.height)
                
                updatedAdjuster.targetSize = CGSize(width: targetWidth, height: targetHeight)
            } else {
                // No PDF loaded or no aspect ratio available, use standard portrait orientation
                updatedAdjuster.targetSize = CGSize(width: preset.width, height: preset.height)
            }
            
            // Switch to Fill mode which is most appropriate for presets
            updatedAdjuster.resizeMode = .fillSize
            
            // Update the adjuster in the array
            var newAdjusters = sizeAdjusters
            newAdjusters[idx] = updatedAdjuster
            
            // Apply change with animation
            withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                sizeAdjusters = newAdjusters
            }
        }
    }
} 