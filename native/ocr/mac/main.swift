import Foundation
import Vision
import AppKit
import CoreGraphics
import ApplicationServices

// Check command line arguments
guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write(Data("Usage: mao-ocr <image-path | --simulate-copy | --get-selection>\n".utf8))
    exit(1)
}

let arg1 = CommandLine.arguments[1]

// Mode: Directly query focused element selection via Accessibility API
if arg1 == "--get-selection" {
    let systemWide = AXUIElementCreateSystemWide()
    var focusedApp: CFTypeRef?
    if AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute as CFString, &focusedApp) == .success,
       let app = focusedApp {
        var focusedElement: CFTypeRef?
        if AXUIElementCopyAttributeValue(app as! AXUIElement, kAXFocusedUIElementAttribute as CFString, &focusedElement) == .success,
           let element = focusedElement {
            var selectedText: CFTypeRef?
            if AXUIElementCopyAttributeValue(element as! AXUIElement, kAXSelectedTextAttribute as CFString, &selectedText) == .success,
               let text = selectedText as? String {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    print(trimmed)
                    exit(0)
                }
            }
        }
    }
    exit(1)
}

// Mode: Hardware-level Cmd+C simulation via CGEventPost
if arg1 == "--simulate-copy" {
    let src = CGEventSource(stateID: .hidSystemState)
    // 0x08 is virtual key for ANSI 'c'
    if let cDown = CGEvent(keyboardEventSource: src, virtualKey: 0x08, keyDown: true) {
        cDown.flags = .maskCommand
        cDown.post(tap: .cghidEventTap)
        cDown.post(tap: .cgSessionEventTap)
    }
    usleep(25_000) // 25ms key press duration
    if let cUp = CGEvent(keyboardEventSource: src, virtualKey: 0x08, keyDown: false) {
        cUp.flags = .maskCommand
        cUp.post(tap: .cghidEventTap)
        cUp.post(tap: .cgSessionEventTap)
    }
    usleep(60_000) // 60ms wait for WindowServer to dispatch event before exiting
    exit(0)
}

let imagePath = CommandLine.arguments[1]
let fileURL = URL(fileURLWithPath: imagePath)

guard FileManager.default.fileExists(atPath: fileURL.path) else {
    FileHandle.standardError.write(Data("Error: File not found: \(fileURL.path)\n".utf8))
    exit(1)
}

guard let image = NSImage(contentsOf: fileURL),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write(Data("Error: Could not decode image at \(fileURL.path)\n".utf8))
    exit(1)
}

struct RecognizedItem {
    let text: String
    let box: CGRect
}

let request = VNRecognizeTextRequest { req, error in
    if let error = error {
        FileHandle.standardError.write(Data("OCR Error: \(error.localizedDescription)\n".utf8))
        return
    }

    guard let observations = req.results as? [VNRecognizedTextObservation] else {
        return
    }

    let items: [RecognizedItem] = observations.compactMap { obs in
        guard let candidate = obs.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces) else {
            return nil
        }
        guard !candidate.isEmpty else { return nil }
        return RecognizedItem(text: candidate, box: obs.boundingBox)
    }

    guard !items.isEmpty else {
        return
    }

    // Sort items by Y descending (in Vision coordinates, Y=1 is top, Y=0 is bottom)
    let sorted = items.sorted { $0.box.midY > $1.box.midY }

    // Group items into lines
    var lines: [[RecognizedItem]] = []
    for item in sorted {
        var matchedIndex: Int?
        for (i, line) in lines.enumerated() {
            if let ref = line.first {
                let lineHeight = max(ref.box.height, item.box.height)
                if abs(ref.box.midY - item.box.midY) < lineHeight * 0.55 {
                    matchedIndex = i
                    break
                }
            }
        }
        if let idx = matchedIndex {
            lines[idx].append(item)
        } else {
            lines.append([item])
        }
    }

    // Sort lines top-to-bottom by average Y
    lines.sort { (lineA, lineB) -> Bool in
        let yA = lineA.map { $0.box.midY }.reduce(0, +) / CGFloat(lineA.count)
        let yB = lineB.map { $0.box.midY }.reduce(0, +) / CGFloat(lineB.count)
        return yA > yB
    }

    // Within each line, sort left-to-right by minX
    let output = lines.map { line in
        line.sorted { $0.box.minX < $1.box.minX }
            .map { $0.text }
            .joined(separator: " ")
    }.joined(separator: "\n")

    print(output)
}

request.recognitionLevel = .accurate
request.recognitionLanguages = [
    "zh-Hans", "zh-Hant", "en-US", "ja-JP", "ko-KR",
    "es-ES", "fr-FR", "de-DE", "ru-RU", "it-IT", "pt-BR"
]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write(Data("Handler Error: \(error.localizedDescription)\n".utf8))
    exit(1)
}
