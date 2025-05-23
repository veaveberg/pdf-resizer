# PDF Resizer

A powerful macOS application for resizing PDF documents with precision and ease.

## Features

- **Multiple Resize Modes**: Fill, Fit, and Custom sizing options
- **Multipage Support**: Process single pages or entire documents
- **Bleed Trimming**: Remove unwanted margins with adjustable trim amounts
- **Batch Processing**: Handle multiple size outputs simultaneously
- **Dynamic Filename Tokens**: Auto-generate filenames with date and size placeholders
- **Live Preview**: See exactly how your PDF will look before processing
- **Permission Error Handling**: Clear feedback for access issues

## System Requirements

- macOS 10.15 or later
- Xcode 13.0 or later (for building from source)

## Installation

### From Source

1. Clone this repository:
   ```bash
   git clone https://github.com/veaveberg/pdf-resizer.git
   cd pdf-resizer
   ```

2. Open `PDF Resizer.xcodeproj` in Xcode

3. Build and run the project

## Usage

1. **Load a PDF**: Drag and drop a PDF file into the application or click to select
2. **Choose Size**: Set your desired output dimensions
3. **Select Resize Mode**:
   - **Fill**: Crop to exact dimensions while maintaining aspect ratio
   - **Fit**: Scale to fit within dimensions without cropping
   - **Custom**: Apply custom scaling
4. **Configure Options**:
   - Set bleed trim amount if needed
   - Choose single page or all pages for multipage documents
   - Customize output filename with dynamic tokens
5. **Export**: Choose your output location and save

## Dynamic Filename Tokens

- `*YYMMDD*` - Automatically replaced with current date (e.g., 251223)
- `*size*` - Automatically replaced with output dimensions (e.g., 210x297)

## Architecture

The app is built with SwiftUI and follows modern macOS app development practices:

- **ContentView.swift**: Main application interface
- **PDFProcessor.swift**: Core PDF processing logic
- **SizeAdjusterRow.swift**: Individual size configuration components
- **WindowManager.swift**: Window management and sizing
- **PDFModels.swift**: Data models and enums
- **PresetEditorView.swift**: Preset management interface

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature-name`)
3. Commit your changes (`git commit -am 'Add feature'`)
4. Push to the branch (`git push origin feature-name`)
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Author

Created by Sasha Berg ([@veaveberg](https://github.com/veaveberg))

---

*PDF Resizer makes it easy to resize and process PDF documents for print, web, or any other purpose while maintaining quality and precision.* 