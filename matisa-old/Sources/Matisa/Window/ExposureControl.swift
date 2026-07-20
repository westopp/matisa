import SwiftUI
import MatisaCore
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins

/// Top-right corner of the detail view's hero. Single "Share" menu that
/// toggles either or both exposure modes; once a mode is active, an
/// inline pill appears below the menu showing the URL plus copy / open /
/// QR / stop controls.
struct ExposureControl: View {
    @Environment(ServiceStore.self) private var store
    let service: Service

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            shareMenu

            let exposure = store.exposure(for: service)
            if exposure.publicTunnel.isActive {
                ExposurePill(
                    kind: .publicTunnel,
                    status: pillStatus(forPublic: exposure.publicTunnel),
                    onCopy: { copy(exposure.publicTunnel.url) },
                    onOpen: { open(exposure.publicTunnel.url) },
                    onStop: { store.tunnels.stop(serviceID: service.id) }
                )
            }
            if exposure.sameNetwork.isActive, let host = exposure.sameNetwork.hostname {
                ExposurePill(
                    kind: .sameNetwork,
                    status: pillStatus(forSameNetwork: exposure.sameNetwork, hostname: host),
                    onCopy: { copy("http://\(host)") },
                    onOpen: { open("http://\(host)") },
                    onStop: { store.toggleSameNetwork(service) }
                )
            }
        }
        .frame(maxWidth: 460, alignment: .trailing)
    }

    // MARK: - Share menu

    @ViewBuilder
    private var shareMenu: some View {
        let exposure = store.exposure(for: service)
        let canPublic = canEnablePublic(exposure: exposure)
        let canLAN = canEnableSameNetwork(exposure: exposure)

        Menu {
            Button {
                store.togglePublicTunnel(service)
            } label: {
                if exposure.publicTunnel.isActive {
                    Label("Public tunnel", systemImage: "checkmark")
                } else {
                    Text("Public tunnel")
                }
            }
            .disabled(!canPublic && !exposure.publicTunnel.isActive)
            .help(publicTooltip(exposure: exposure))

            Button {
                store.toggleSameNetwork(service)
            } label: {
                if exposure.sameNetwork.isActive {
                    Label("Same network", systemImage: "checkmark")
                } else {
                    Text("Same network")
                }
            }
            .disabled(!canLAN && !exposure.sameNetwork.isActive)
            .help(sameNetworkTooltip(exposure: exposure))
        } label: {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(!service.state.isRunning)
        .opacity(service.state.isRunning ? 1.0 : 0.35)
        .help(service.state.isRunning ? "Expose externally" : "Start the service to expose it externally")
    }

    private func canEnablePublic(exposure: ServiceExposure) -> Bool {
        guard service.state.isRunning else { return false }
        return TunnelManager.sshKeyExists(store.tunnelConfig)
    }

    private func canEnableSameNetwork(exposure: ServiceExposure) -> Bool {
        guard service.state.isRunning else { return false }
        return store.mdns.hasLANInterface
    }

    private func publicTooltip(exposure: ServiceExposure) -> String {
        if exposure.publicTunnel.isActive { return "Stop the public tunnel" }
        if !service.state.isRunning { return "Start the service to enable a public tunnel" }
        if !TunnelManager.sshKeyExists(store.tunnelConfig) {
            return "SSH key not found at \(store.tunnelConfig.sshKeyPath.path)"
        }
        return "Open a public tunnel"
    }

    private func sameNetworkTooltip(exposure: ServiceExposure) -> String {
        if exposure.sameNetwork.isActive { return "Stop advertising on the local network" }
        if !service.state.isRunning { return "Start the service to expose it on the local network" }
        if !store.mdns.hasLANInterface { return "No LAN interface available" }
        return "Expose on the local network"
    }

    private func pillStatus(forPublic status: PublicTunnelStatus) -> ExposurePill.Status {
        switch status {
        case .idle, .disconnected: .disconnected
        case .connecting: .connecting
        case .live(let url): .live(url)
        case .error(let msg): .error(msg)
        }
    }

    private func pillStatus(
        forSameNetwork status: SameNetworkStatus,
        hostname: String
    ) -> ExposurePill.Status {
        switch status {
        case .idle: .disconnected
        case .advertising: .connecting
        case .active: .live("http://\(hostname)")
        case .error(let msg): .error(msg)
        }
    }

    private func copy(_ string: String?) {
        guard let string else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(string, forType: .string)
    }

    private func open(_ string: String?) {
        guard let string, let url = URL(string: string) else { return }
        NSWorkspace.shared.open(url)
    }
}

// MARK: - ExposurePill

struct ExposurePill: View {
    enum Kind {
        case publicTunnel
        case sameNetwork

        var tint: Color {
            switch self {
            case .publicTunnel: Color(red: 0.36, green: 0.55, blue: 0.95)  // blue
            case .sameNetwork:  Color(red: 0.20, green: 0.65, blue: 0.65)  // teal
            }
        }

        var icon: String {
            switch self {
            case .publicTunnel: "globe"
            case .sameNetwork:  "wifi"
            }
        }

        var label: String {
            switch self {
            case .publicTunnel: "Public"
            case .sameNetwork:  "Local"
            }
        }
    }

    enum Status {
        case connecting
        case live(String)
        case disconnected
        case error(String)
    }

    let kind: Kind
    let status: Status
    let onCopy: () -> Void
    let onOpen: () -> Void
    let onStop: () -> Void

    @State private var qrPresented = false

    var body: some View {
        HStack(spacing: 6) {
            urlCapsule

            switch status {
            case .live(let url):
                IconButton("doc.on.doc", help: "Copy URL", onTap: onCopy)
                IconButton("safari", help: "Open in browser", onTap: onOpen)
                Button {
                    qrPresented = true
                } label: {
                    Image(systemName: "qrcode")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .help("Show QR code")
                .popover(isPresented: $qrPresented, arrowEdge: .top) {
                    QRPopover(url: url, kind: kind)
                }
            default:
                EmptyView()
            }

            IconButton("xmark.circle", help: "Stop", tint: .red, onTap: onStop)
        }
    }

    @ViewBuilder
    private var urlCapsule: some View {
        HStack(spacing: 6) {
            Image(systemName: kind.icon)
                .font(.caption)
            Group {
                switch status {
                case .connecting:
                    HStack(spacing: 5) {
                        Text(kind.label)
                            .font(.caption.weight(.medium))
                        Text("connecting…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                case .live(let url):
                    Text(url)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                case .disconnected:
                    HStack(spacing: 5) {
                        Text(kind.label)
                            .font(.caption.weight(.medium))
                        Text("disconnected")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                case .error(let msg):
                    HStack(spacing: 5) {
                        Text(kind.label)
                            .font(.caption.weight(.medium))
                        Text(msg)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .help(msg)
                    }
                }
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background {
            Capsule().fill(kind.tint.opacity(0.15))
        }
        .overlay {
            Capsule().strokeBorder(kind.tint.opacity(0.45))
        }
        .foregroundStyle(kind.tint)
    }
}

// MARK: - QR popover

private struct QRPopover: View {
    let url: String
    let kind: ExposurePill.Kind

    var body: some View {
        VStack(spacing: 10) {
            Text(url)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(2)
                .truncationMode(.middle)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 220)

            if let qr = QRImage.make(url) {
                Image(nsImage: qr)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 180, height: 180)
                    .padding(8)
                    .background(Color.white)
                    .overlay {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.15))
                    }
            } else {
                Text("Failed to generate QR")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
    }
}

enum QRImage {
    static func make(_ string: String) -> NSImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let outputImage = filter.outputImage else { return nil }
        // Scale up — the raw CI output is one pixel per module.
        let scale: CGFloat = 10
        let scaled = outputImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
    }
}
