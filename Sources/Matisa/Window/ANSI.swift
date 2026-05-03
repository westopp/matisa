import SwiftUI

/// Converts a string containing ANSI escape sequences into a SwiftUI
/// `AttributedString` with foreground/background colors, bold, italic, and
/// underline attributes applied per-run.
///
/// Scope:
///   - SGR (Select Graphic Rendition) — `ESC [ <params> m`. The colorful
///     subset of ANSI; covers ~all dev-tool log output.
///     - 16-color (30–37, 40–47, 90–97, 100–107)
///     - 256-color (38;5;n / 48;5;n)
///     - 24-bit truecolor (38;2;r;g;b / 48;2;r;g;b)
///     - 0 reset, 1 bold, 3 italic, 4 underline, 22/23/24 to clear them.
///   - Non-SGR escapes (cursor moves, clear screen, …) are stripped — they
///     don't make sense in an append-only log pane.
///
/// Performance: this re-parses the whole buffer on every invocation. The
/// log buffers are capped (~200 KB), so cost is bounded; if it ever becomes
/// noticeable we can cache the parsed prefix and only parse the tail.
enum ANSI {
    static func attributedString(from raw: String) -> AttributedString {
        var result = AttributedString()
        var current = SGRStyle()
        var pending = ""

        func flush() {
            guard !pending.isEmpty else { return }
            var run = AttributedString(pending)
            apply(style: current, to: &run)
            result += run
            pending = ""
        }

        let scalars = Array(raw.unicodeScalars)
        var i = 0
        while i < scalars.count {
            let s = scalars[i]
            if s.value == 0x1B, i + 1 < scalars.count, scalars[i + 1] == "[" {
                flush()
                // Scan parameters up to a CSI final byte (0x40..0x7E).
                var j = i + 2
                var params = ""
                var finalByte: UnicodeScalar? = nil
                while j < scalars.count {
                    let cj = scalars[j]
                    if cj.value >= 0x40 && cj.value <= 0x7E {
                        finalByte = cj
                        j += 1
                        break
                    }
                    params.unicodeScalars.append(cj)
                    j += 1
                }
                if finalByte == "m" {
                    applySGR(params: params, into: &current)
                }
                // Other CSI finals are silently dropped.
                i = j
            } else {
                pending.unicodeScalars.append(s)
                i += 1
            }
        }
        flush()
        return result
    }

    // MARK: - Style

    private struct SGRStyle {
        var foreground: Color? = nil
        var background: Color? = nil
        var bold: Bool = false
        var italic: Bool = false
        var underline: Bool = false
    }

    private static func apply(style: SGRStyle, to s: inout AttributedString) {
        if let fg = style.foreground { s.foregroundColor = fg }
        if let bg = style.background { s.backgroundColor = bg }
        if style.bold || style.italic {
            // Match the base log font (.caption monospaced) and layer
            // weight/italic on top.
            var f = Font.system(.caption, design: .monospaced)
            if style.bold { f = f.weight(.bold) }
            if style.italic { f = f.italic() }
            s.font = f
        }
        if style.underline { s.underlineStyle = .single }
    }

    // MARK: - SGR

    private static func applySGR(params: String, into style: inout SGRStyle) {
        let parts: [Int] = (params.isEmpty ? "0" : params)
            .split(separator: ";", omittingEmptySubsequences: false)
            .map { Int($0) ?? 0 }

        var i = 0
        while i < parts.count {
            let n = parts[i]
            switch n {
            case 0:
                style = SGRStyle()
            case 1: style.bold = true
            case 3: style.italic = true
            case 4: style.underline = true
            case 22: style.bold = false
            case 23: style.italic = false
            case 24: style.underline = false
            case 30...37:
                style.foreground = standardColor(n - 30, bright: false)
            case 90...97:
                style.foreground = standardColor(n - 90, bright: true)
            case 40...47:
                style.background = standardColor(n - 40, bright: false)
            case 100...107:
                style.background = standardColor(n - 100, bright: true)
            case 39: style.foreground = nil
            case 49: style.background = nil
            case 38, 48:
                // 38;5;n — 256 color. 38;2;r;g;b — truecolor.
                if i + 2 < parts.count, parts[i + 1] == 5 {
                    let c = xterm256(parts[i + 2])
                    if n == 38 { style.foreground = c } else { style.background = c }
                    i += 3
                    continue
                }
                if i + 4 < parts.count, parts[i + 1] == 2 {
                    let c = Color(
                        red: Double(parts[i + 2]) / 255.0,
                        green: Double(parts[i + 3]) / 255.0,
                        blue: Double(parts[i + 4]) / 255.0
                    )
                    if n == 38 { style.foreground = c } else { style.background = c }
                    i += 5
                    continue
                }
            default:
                break
            }
            i += 1
        }
    }

    // MARK: - Palettes

    /// Tuned for legibility on both light and dark backgrounds. Slightly
    /// muted to avoid eye-melting saturated reds/greens.
    private static func standardColor(_ idx: Int, bright: Bool) -> Color {
        let normal: [Color] = [
            Color(red: 0.30, green: 0.30, blue: 0.30),  // black
            Color(red: 0.80, green: 0.25, blue: 0.25),  // red
            Color(red: 0.25, green: 0.65, blue: 0.30),  // green
            Color(red: 0.75, green: 0.55, blue: 0.10),  // yellow
            Color(red: 0.25, green: 0.50, blue: 0.85),  // blue
            Color(red: 0.65, green: 0.30, blue: 0.75),  // magenta
            Color(red: 0.20, green: 0.65, blue: 0.65),  // cyan
            Color(red: 0.70, green: 0.70, blue: 0.70),  // white
        ]
        let brightV: [Color] = [
            Color(red: 0.50, green: 0.50, blue: 0.50),
            Color(red: 1.00, green: 0.42, blue: 0.42),
            Color(red: 0.42, green: 0.85, blue: 0.50),
            Color(red: 0.95, green: 0.78, blue: 0.30),
            Color(red: 0.42, green: 0.65, blue: 1.00),
            Color(red: 0.85, green: 0.50, blue: 0.95),
            Color(red: 0.42, green: 0.85, blue: 0.85),
            Color(red: 0.95, green: 0.95, blue: 0.95),
        ]
        let palette = bright ? brightV : normal
        return palette[max(0, min(7, idx))]
    }

    private static func xterm256(_ idx: Int) -> Color {
        let i = max(0, min(255, idx))
        if i < 16 {
            return standardColor(i % 8, bright: i >= 8)
        }
        if i >= 232 {
            // 24-step grayscale ramp.
            let level = Double(i - 232) / 23.0
            return Color(red: level, green: level, blue: level)
        }
        // 6×6×6 RGB cube.
        let n = i - 16
        let r = (n / 36) % 6
        let g = (n / 6) % 6
        let b = n % 6
        let lookup: [Double] = [0, 95.0 / 255, 135.0 / 255, 175.0 / 255, 215.0 / 255, 1.0]
        return Color(red: lookup[r], green: lookup[g], blue: lookup[b])
    }
}
