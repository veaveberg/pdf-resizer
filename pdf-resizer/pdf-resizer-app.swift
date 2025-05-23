//
//  PDFResizerApp.swift
//  PDFResizer
//
//  Created by Sasha on 5/15/25.
//

import SwiftUI

@main
struct PDFResizerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowStyle(.automatic)
        .windowToolbarStyle(.unified)
        .defaultSize(width: WindowManager.fixedWidth, height: WindowManager.defaultInitialHeight)
        .windowResizability(.contentSize)
    }
}
