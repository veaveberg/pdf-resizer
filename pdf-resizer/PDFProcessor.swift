import PDFKit
import AppKit // For NSColor, CGContext
import CoreGraphics // For CGSize, CGRect, CGAffineTransform etc.
import Foundation // For DateFormatter, FileManager, Date, NSError

struct PDFProcessor {

    // A-series paper sizes in points (72 points per inch)
    static let aSeriesSizes: [(name: String, size: CGSize)] = [
        ("A0", CGSize(width: 2384, height: 3370)), // 841 × 1189 mm
        ("A1", CGSize(width: 1684, height: 2384)), // 594 × 841 mm
        ("A2", CGSize(width: 1191, height: 1684)), // 420 × 594 mm
        ("A3", CGSize(width: 842, height: 1191)),  // 297 × 420 mm
        ("A4", CGSize(width: 595, height: 842)),   // 210 × 297 mm
        ("A5", CGSize(width: 420, height: 595)),   // 148 × 210 mm
    ]
    
    // Function to detect if a size matches an A-series paper size
    static func isASeries(size: CGSize, tolerancePoints: CGFloat = 2.0) -> (matches: Bool, name: String, orientation: String) {
        // Convert to mm for more intuitive tolerance values
        let widthMm = size.width.toMillimeters
        let heightMm = size.height.toMillimeters
        
        for paperSize in aSeriesSizes {
            let paperWidthMm = paperSize.size.width.toMillimeters
            let paperHeightMm = paperSize.size.height.toMillimeters
            
            // Check portrait orientation (original A-series orientation)
            if abs(widthMm - paperWidthMm) <= tolerancePoints && abs(heightMm - paperHeightMm) <= tolerancePoints {
                return (true, paperSize.name, "")
            }
            
            // Check landscape orientation
            if abs(widthMm - paperHeightMm) <= tolerancePoints && abs(heightMm - paperWidthMm) <= tolerancePoints {
                return (true, paperSize.name, "h") // 'h' suffix for horizontal/landscape
            }
        }
        
        return (false, "", "")
    }

    // Calculate the effective size after trimming bleed
    static func calculateEffectiveSizeAfterBleedTrim(currentSize: CGSize, bleedTrimAmount: CGFloat) -> CGSize {
        // bleedTrimAmount is in mm, so convert to points
        let bleedTrimPoints = CGFloat.fromMillimeters(bleedTrimAmount)
        
        // Trim from all sides (2x for width and height)
        let trimmedWidth = max(currentSize.width - (bleedTrimPoints * 2), 1)
        let trimmedHeight = max(currentSize.height - (bleedTrimPoints * 2), 1)
        
        return CGSize(width: trimmedWidth, height: trimmedHeight)
    }

    static func calculateResultingSize(for adjuster: SizeAdjuster, currentSize: CGSize?, bleedTrimAmount: CGFloat = 0) -> CGSize {
        guard let originalSize = currentSize, originalSize.height != 0, originalSize.width != 0 else { 
            // If currentSize is nil or has zero dimension, aspect ratio calculation is not possible.
            // Return the adjuster's targetSize directly.
            return adjuster.targetSize 
        }
        
        // Apply bleed trimming to get effective input size
        let effectiveSize = calculateEffectiveSizeAfterBleedTrim(currentSize: originalSize, bleedTrimAmount: bleedTrimAmount)
        let aspectRatio = effectiveSize.width / effectiveSize.height
        
        // This logic assumes SizeAdjuster.targetSize contains the user's primary input value(s)
        // based on the active UI fields for the selected ResizeMode.
        switch adjuster.resizeMode {
        case .fillSize:
            // User specifies both width and height directly via adjuster.targetSize.
            return adjuster.targetSize
        case .fitWidth: 
            // UI interpretation: User sets HEIGHT (adjuster.targetSize.height), WIDTH is calculated.
            // This case name might seem counter-intuitive. It means the content's width is fitted to match the aspect ratio
            // once the height is set.
            let newWidth = adjuster.targetSize.height * aspectRatio
            return CGSize(width: newWidth, height: adjuster.targetSize.height)
        case .fitHeight: 
            // UI interpretation: User sets WIDTH (adjuster.targetSize.width), HEIGHT is calculated.
            // Content's height is fitted to match aspect ratio once width is set.
            let newHeight = adjuster.targetSize.width / aspectRatio
            return CGSize(width: adjuster.targetSize.width, height: newHeight)
        }
    }

    static func processAndSavePDFs(
        inputURL: URL,
        saveFolderURL: URL,
        sizeAdjusters: [SizeAdjuster],
        baseFileName: String,
        useSubfolder: Bool,
        subfolderName: String,
        currentPDFSize: CGSize?, // Original PDF dimensions in points
        bleedTrimAmount: CGFloat = 0, // Amount to trim in mm
        dateForFileName: Date = Date(),
        allowOverwrite: Bool = true, // Added parameter with default value
        pageIndices: [Int] = [0] // Changed to array of page indices
    ) -> (savedFiles: [String], errors: [String]) {
        
        var savedFileNamesInternal: [String] = [] // To track filenames within this batch
        var errorsEncountered: [String] = []

        // Load PDF document to access multiple pages
        guard let pdfDocument = PDFKit.PDFDocument(url: inputURL) else {
            errorsEncountered.append("Could not load input PDF document.")
            return (savedFileNamesInternal, errorsEncountered)
        }
        
        // Process each page in the pageIndices array
        for pageIndex in pageIndices {
            // Skip if page index is out of range
            guard pageIndex >= 0 && pageIndex < pdfDocument.pageCount else {
                errorsEncountered.append("Page index \(pageIndex+1) is out of range (total pages: \(pdfDocument.pageCount)).")
                continue
            }
            
            // Get page dimensions for this specific page
            let pageSize: CGSize
            if let page = pdfDocument.page(at: pageIndex) {
                pageSize = page.bounds(for: .mediaBox).size
            } else if let fallbackSize = currentPDFSize {
                // Fall back to the provided currentPDFSize if we can't get the specific page
                pageSize = fallbackSize
                print("Warning: Using fallback page size for page \(pageIndex)")
            } else {
                errorsEncountered.append("No size information available for page \(pageIndex+1).")
                continue
            }

            for adjuster in sizeAdjusters {
                print("---- Processing Adjuster: ID \(adjuster.id), Mode: \(adjuster.resizeMode), Target: \(adjuster.targetSize.width)x\(adjuster.targetSize.height) for Page \(pageIndex + 1) ----") // DEBUG
                var finalFileName = baseFileName
                
                let dateFormatter = DateFormatter()
                dateFormatter.dateFormat = "yyMMdd"
                let dateString = dateFormatter.string(from: dateForFileName)
                
                let outputSizeInPoints = calculateResultingSize(for: adjuster, currentSize: pageSize, bleedTrimAmount: bleedTrimAmount)
                print("Adjuster ID \(adjuster.id) -> Calculated outputSizeInPoints: \(outputSizeInPoints.width)x\(outputSizeInPoints.height)") // DEBUG
                
                // Check if size matches an A-series paper size
                let aSeriesInfo = isASeries(size: outputSizeInPoints)
                
                // Generate size string for filename
                let sizeString: String
                if aSeriesInfo.matches {
                    // Use A-series notation with optional orientation suffix
                    sizeString = "_\(aSeriesInfo.name)\(aSeriesInfo.orientation)_"
                } else {
                    // Use traditional dimensions
                    let widthMm = Int(round(outputSizeInPoints.width.toMillimeters))
                    let heightMm = Int(round(outputSizeInPoints.height.toMillimeters))
                    sizeString = "_\(widthMm)x\(heightMm)_"
                }
                print("Adjuster ID \(adjuster.id) -> Filename size part: \(sizeString)") // DEBUG
                
                finalFileName = finalFileName.replacingOccurrences(of: "*YYMMDD*", with: "_\(dateString)_")
                finalFileName = finalFileName.replacingOccurrences(of: "*size*", with: sizeString)
                
                // Add page number to filename if multi-page PDF and more than one page is being processed
                if pageIndices.count > 1 || pageIndex > 0 {
                    finalFileName += "_p\(pageIndex + 1)"
                }
                
                while finalFileName.contains("__") {
                    finalFileName = finalFileName.replacingOccurrences(of: "__", with: "_")
                }
                finalFileName = finalFileName.trimmingCharacters(in: CharacterSet(charactersIn: "_"))

                var uniqueFileName = finalFileName
                var suffix = 1
                while savedFileNamesInternal.contains(uniqueFileName + ".pdf") {
                    uniqueFileName = finalFileName + "_\(suffix)"
                    suffix += 1
                }
                
                let effectiveSaveFolder: URL
                if useSubfolder && !subfolderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    effectiveSaveFolder = saveFolderURL.appendingPathComponent(subfolderName.trimmingCharacters(in: .whitespacesAndNewlines))
                    do {
                        try FileManager.default.createDirectory(at: effectiveSaveFolder, withIntermediateDirectories: true, attributes: nil)
                    } catch {
                        errorsEncountered.append("Could not create subfolder '\(subfolderName)': \(error.localizedDescription)")
                        continue 
                    }
                } else {
                    effectiveSaveFolder = saveFolderURL
                }
                
                let saveURL = effectiveSaveFolder.appendingPathComponent(uniqueFileName + ".pdf")
                
                // MODIFIED: Functional allowOverwrite check
                if !allowOverwrite && FileManager.default.fileExists(atPath: saveURL.path) {
                    print("File exists and overwrite is disabled, skipping: \(saveURL.lastPathComponent)")
                    errorsEncountered.append("Skipped existing file (overwrite disabled): \(saveURL.lastPathComponent)")
                    continue // Skip this file if overwrite is not allowed and it exists
                }

                do {
                    guard let page = pdfDocument.page(at: pageIndex) else {
                        throw NSError(domain: "PDFProcessorError", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not load requested page \(pageIndex + 1)."])
                    }
                    
                    let originalMediaBox = page.bounds(for: .mediaBox)
                    
                    // Apply bleed trimming if specified
                    let effectiveInputRect: CGRect
                    if bleedTrimAmount > 0 {
                        // Convert bleedTrimAmount from mm to points
                        let bleedTrimPoints = CGFloat.fromMillimeters(bleedTrimAmount)
                        
                        // Create a rect that's smaller by the bleed amount on all sides
                        effectiveInputRect = originalMediaBox.insetBy(dx: bleedTrimPoints, dy: bleedTrimPoints)
                        print("Applying bleed trim: \(bleedTrimAmount)mm (\(bleedTrimPoints)pt)")
                        print("Original MediaBox: \(originalMediaBox), After trim: \(effectiveInputRect)")
                    } else {
                        effectiveInputRect = originalMediaBox
                    }

                    let scale: CGFloat
                    if adjuster.resizeMode == .fillSize {
                        scale = max(outputSizeInPoints.width / effectiveInputRect.width,
                                    outputSizeInPoints.height / effectiveInputRect.height)
                    } else {
                        scale = min(outputSizeInPoints.width / effectiveInputRect.width,
                                    outputSizeInPoints.height / effectiveInputRect.height)
                    }

                    let scaledContentWidth = effectiveInputRect.width * scale
                    let scaledContentHeight = effectiveInputRect.height * scale
                    
                    let offsetX = (outputSizeInPoints.width - scaledContentWidth) / 2
                    let offsetY = (outputSizeInPoints.height - scaledContentHeight) / 2
                    
                    var transform = CGAffineTransform.identity
                    transform = transform.translatedBy(x: offsetX, y: offsetY)
                    transform = transform.scaledBy(x: scale, y: scale)
                    transform = transform.translatedBy(x: -effectiveInputRect.minX, y: -effectiveInputRect.minY)

                    var mediaBoxRect = CGRect(x: 0, y: 0, width: outputSizeInPoints.width, height: outputSizeInPoints.height)
                    
                    let pdfData = NSMutableData()
                    guard let consumer = CGDataConsumer(data: pdfData as CFMutableData),
                          let context = CGContext(consumer: consumer, mediaBox: &mediaBoxRect, nil) else {
                        throw NSError(domain: "PDFProcessorError", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not create graphics context."])
                    }
                    
                    context.beginPDFPage(nil)
                    context.saveGState()
                    context.setFillColor(NSColor.white.cgColor)
                    context.fill(mediaBoxRect)
                    context.restoreGState()
                    
                    context.saveGState()
                    context.concatenate(transform)
                    
                    // If using bleed trim, create a clipping path to trim the content
                    if bleedTrimAmount > 0 {
                        context.clip(to: effectiveInputRect)
                    }
                    
                    page.draw(with: .mediaBox, to: context)
                    context.restoreGState()
                    
                    context.endPDFPage()
                    context.closePDF()
                                    
                    try pdfData.write(to: saveURL)
                    savedFileNamesInternal.append(saveURL.lastPathComponent)
                    
                } catch {
                    errorsEncountered.append("Error for '\(uniqueFileName).pdf': \(error.localizedDescription)")
                }
            }
        }
        
        return (savedFileNamesInternal, errorsEncountered)
    }

    // Updated for bleed trimming
    static func generateProspectiveFilePaths(
        inputURL: URL,
        saveFolderURL: URL,
        sizeAdjusters: [SizeAdjuster],
        baseFileName: String,
        useSubfolder: Bool,
        subfolderName: String,
        currentPDFSize: CGSize?,
        bleedTrimAmount: CGFloat = 0,
        dateForFileName: Date = Date(),
        pageIndices: [Int] = [0] // Changed to array of page indices
    ) -> ([URL], [SizeAdjuster.ID]) {
        
        print("PDFProcessor.generateProspectiveFilePaths called")
        var urls: [URL] = []
        var ids: [SizeAdjuster.ID] = []

        // Load PDF document to access multiple pages if needed
        guard let pdfDocument = PDFKit.PDFDocument(url: inputURL) else {
            print("Error: Could not load PDF document in generateProspectiveFilePaths")
            return (urls, ids)
        }
        
        // Process each page in the pageIndices array
        for pageIndex in pageIndices {
            // Skip if page index is out of range
            guard pageIndex >= 0 && pageIndex < pdfDocument.pageCount else {
                print("Warning: Page index \(pageIndex) is out of range (0-\(pdfDocument.pageCount-1))")
                continue
            }
            
            // Get page dimensions for this specific page
            let pageSize: CGSize
            if let page = pdfDocument.page(at: pageIndex) {
                pageSize = page.bounds(for: .mediaBox).size
            } else if let fallbackSize = currentPDFSize {
                // Fall back to the provided currentPDFSize if we can't get the specific page
                pageSize = fallbackSize
                print("Warning: Using fallback page size for page \(pageIndex)")
            } else {
                print("Error: No size information available for page \(pageIndex)")
                continue
            }
            
            for adjuster in sizeAdjusters {
                var finalFileName = baseFileName
                let dateFormatter = DateFormatter()
                dateFormatter.dateFormat = "yyMMdd"
                let dateString = dateFormatter.string(from: dateForFileName)
                
                let outputSizeInPoints = calculateResultingSize(for: adjuster, currentSize: pageSize, bleedTrimAmount: bleedTrimAmount)
                
                // Check if size matches an A-series paper size
                let aSeriesInfo = isASeries(size: outputSizeInPoints)
                
                // Generate size string for filename
                let sizeString: String
                if aSeriesInfo.matches {
                    // Use A-series notation with optional orientation suffix
                    sizeString = "_\(aSeriesInfo.name)\(aSeriesInfo.orientation)_"
                } else {
                    // Use traditional dimensions
                    let widthMm = Int(round(outputSizeInPoints.width.toMillimeters))
                    let heightMm = Int(round(outputSizeInPoints.height.toMillimeters))
                    sizeString = "_\(widthMm)x\(heightMm)_"
                }
                
                finalFileName = finalFileName.replacingOccurrences(of: "*YYMMDD*", with: "_\(dateString)_")
                finalFileName = finalFileName.replacingOccurrences(of: "*size*", with: sizeString)
                
                // Add page number to filename if multi-page PDF and more than one page is being processed
                if pageIndices.count > 1 || pageIndex > 0 {
                    finalFileName += "_p\(pageIndex + 1)"
                }
                
                while finalFileName.contains("__") { finalFileName = finalFileName.replacingOccurrences(of: "__", with: "_") }
                finalFileName = finalFileName.trimmingCharacters(in: CharacterSet(charactersIn: "_"))

                let effectiveSaveFolder: URL
                if useSubfolder && !subfolderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    effectiveSaveFolder = saveFolderURL.appendingPathComponent(subfolderName.trimmingCharacters(in: .whitespacesAndNewlines))
                } else {
                    effectiveSaveFolder = saveFolderURL
                }
                urls.append(effectiveSaveFolder.appendingPathComponent(finalFileName + ".pdf"))
                ids.append(adjuster.id)
            }
        }
        
        return (urls, ids)
    }
} 