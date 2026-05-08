import SwiftUI
import AppKit

/// Popover content for a captured `LaunchFailure`. Anchored from the small
/// red indicator next to the service name in the sidebar. Fixed-width with
/// an internally-scrolling log-tail panel so its sizing can't propagate
/// into the surrounding sidebar / detail layout.
///
/// Provides:
///   - The one-line summary used everywhere else (selectable).
///   - The full captured stderr/log tail (selectable, scrollable).
///   - Copy-to-clipboard for the whole error block.
///   - Clear, which removes the failure capture (and the indicator).
struct LaunchFailurePopover: View {
    let serviceID: String
    let failure: LaunchFailure
    let onClose: () -> Void

    @Environment(ServiceStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            summarySection
            if !failure.logTail.isEmpty {
                logSection
            }
            footerActions
        }
        .padding(16)
        .frame(width: 480)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.octagon.fill")
                .foregroundStyle(.red)
            Text("Last launch failed")
                .font(.headline)
            Spacer()
        }
    }

    @ViewBuilder
    private var summarySection: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionLabel("Summary")
            Text(failure.summary)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var logSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionLabel("Log tail")
            ScrollView(.vertical) {
                Text(failure.logTail)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 160)
            .background {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.black.opacity(0.06))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.10))
            }
        }
    }

    @ViewBuilder
    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
    }

    private var footerActions: some View {
        HStack(spacing: 8) {
            Button {
                copyToClipboard()
            } label: {
                Label("Copy error", systemImage: "doc.on.doc")
            }
            if let log = store.service(id: serviceID)?.logsPath {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([log])
                } label: {
                    Label("Reveal log", systemImage: "folder")
                }
            }
            Spacer()
            Button(role: .destructive) {
                store.clearLaunchFailure(for: serviceID)
                onClose()
            } label: {
                Text("Clear")
            }
        }
    }

    private func copyToClipboard() {
        var payload = failure.summary
        if !failure.logTail.isEmpty {
            payload += "\n\n" + failure.logTail
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(payload, forType: .string)
    }
}
