import SwiftUI
import AppKit

/// "Command-line tool" section shown inside `EngineDetailView`. Surfaces
/// `CLIInstaller`'s state machine, lets the user toggle the
/// `/usr/local/bin/matisa` symlink, and falls back to a
/// copy-pasteable `sudo ln -sf …` command when the install path isn't
/// writable.
///
/// Hidden entirely when the app isn't running from a `.app` bundle —
/// there's no stable binary to symlink to during `swift run` development.
struct CLIInstallSection: View {

    @State private var state: CLIInstaller.State = .notInstalled
    @State private var lastResult: CLIInstaller.ActionResult? = nil
    @State private var working = false
    @State private var sudoSheetVisible = false

    var body: some View {
        Group {
            if case .notInBundle = state {
                // Suppress the section entirely outside a .app bundle.
                EmptyView()
            } else {
                content
            }
        }
        .onAppear { refreshState() }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Command-line tool")
                .font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                Image(systemName: "terminal.fill")
                    .foregroundStyle(.secondary)
                Text(statusLabel)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                actionButton
            }

            if let detail = secondaryLine {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .sheet(isPresented: $sudoSheetVisible) {
            sudoFallbackSheet
        }
    }

    // MARK: - Status text

    private var statusLabel: String {
        switch state {
        case .notInBundle:        return ""
        case .notInstalled:       return "Not installed"
        case .installedHere:      return "Installed at \(CLIInstaller.symlinkPath)"
        case .installedElsewhere: return "Installed (other location)"
        case .occupiedByOtherFile:
            return "Other file at \(CLIInstaller.symlinkPath)"
        }
    }

    /// Second line — context the user needs to make sense of the state
    /// before clicking. Empty for the boring cases (not installed, or
    /// installed-here is self-explanatory).
    private var secondaryLine: String? {
        switch state {
        case .installedElsewhere(let target):
            return "Currently links to \(target). Click Replace to point at this app."
        case .occupiedByOtherFile:
            return "Something other than a symlink is occupying that path. Inspect it manually before replacing."
        case .notInstalled:
            return "Run \(quotedCLIPath) directly, or click Install to symlink it onto your PATH."
        case .installedHere, .notInBundle:
            return nil
        }
    }

    private var quotedCLIPath: String {
        guard let p = CLIInstaller.bundledCLIPath else { return "matisa" }
        return "\(p)"
    }

    // MARK: - Action button

    @ViewBuilder
    private var actionButton: some View {
        switch state {
        case .notInBundle:
            EmptyView()
        case .notInstalled:
            chip("Install", tint: .accentColor) { performInstall() }
        case .installedHere:
            chip("Uninstall", tint: .red.opacity(0.85)) { performUninstall() }
        case .installedElsewhere:
            chip("Replace", tint: .accentColor) { performInstall() }
        case .occupiedByOtherFile:
            chip("Replace", tint: .accentColor) { performInstall() }
        }
    }

    @ViewBuilder
    private func chip(_ label: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button {
            action()
        } label: {
            HStack(spacing: 5) {
                if working { ProgressView().controlSize(.mini) }
                Text(working ? "Working…" : label)
            }
            .font(.callout.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(tint.opacity(0.18))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(tint.opacity(0.45))
            }
            .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
        .disabled(working)
    }

    // MARK: - Actions

    private func performInstall() {
        guard !working else { return }
        working = true
        // Symlink work is microseconds; off-main is overkill but keeps the
        // UI snappy in case anything (the file probe in state()) ever
        // becomes I/O-bound.
        DispatchQueue.global(qos: .userInitiated).async {
            let result = CLIInstaller.install()
            DispatchQueue.main.async {
                handle(result: result)
            }
        }
    }

    private func performUninstall() {
        guard !working else { return }
        working = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = CLIInstaller.uninstall()
            DispatchQueue.main.async {
                handle(result: result)
            }
        }
    }

    private func handle(result: CLIInstaller.ActionResult) {
        lastResult = result
        working = false
        switch result {
        case .success:
            refreshState()
        case .permissionDenied:
            // Sheet shows the sudo command, then refreshes on dismiss in
            // case the user ran it.
            sudoSheetVisible = true
        case .error:
            // Stays on-screen via secondaryLine alternative below; for
            // now, refresh so the user sees the current state alongside
            // the in-row error.
            refreshState()
        }
    }

    private func refreshState() {
        state = CLIInstaller.state()
    }

    // MARK: - Sudo fallback sheet

    private var sudoFallbackSheet: some View {
        let cmd: String = {
            if case .permissionDenied(let c) = lastResult { return c }
            return CLIInstaller.sudoCommand(bundled: CLIInstaller.bundledCLIPath ?? "")
        }()
        return VStack(alignment: .leading, spacing: 14) {
            Text("Permission required")
                .font(.headline)
            Text("Matisa couldn't write to \(CLIInstaller.symlinkPath) directly. Paste this into Terminal — it'll prompt for your password, then drop the symlink in place.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .top, spacing: 8) {
                Text(cmd)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.primary.opacity(0.05))
                    }
                Button {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.setString(cmd, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .help("Copy to clipboard")
            }

            HStack {
                Spacer()
                Button("Done") {
                    sudoSheetVisible = false
                    refreshState()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}
