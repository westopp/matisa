import SwiftUI

struct EngineDetailView: View {
    @Environment(ServiceStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Image(systemName: "gearshape.2.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Matisa Engine")
                        .font(.title2.weight(.semibold))
                    Text(headerSubtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(store.engineStatus != nil ? "Stop" : "Start") {
                    Task {
                        if store.engineStatus != nil {
                            await store.performEngineStop()
                        } else {
                            await store.performEngineStart()
                        }
                    }
                }
                .controlSize(.large)
            }

            Divider()

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    Text("Status").foregroundStyle(.secondary)
                    Text(store.engineStatus?.status ?? "—")
                }
                GridRow {
                    Text("Version").foregroundStyle(.secondary)
                    Text(store.engineStatus?.version ?? "—")
                }
                GridRow {
                    Text("Uptime").foregroundStyle(.secondary)
                    Text(uptimeLabel)
                }
                GridRow {
                    Text("Socket").foregroundStyle(.secondary)
                    Text(EngineClient.defaultSocketPath())
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            .font(.body)

            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var headerSubtitle: String {
        store.engineStatus != nil ? "Running" : "Not reachable"
    }

    private var uptimeLabel: String {
        guard let s = store.engineStatus else { return "—" }
        let h = s.uptimeSeconds / 3600
        let m = (s.uptimeSeconds % 3600) / 60
        let sec = s.uptimeSeconds % 60
        if h > 0 { return "\(h)h \(m)m \(sec)s" }
        if m > 0 { return "\(m)m \(sec)s" }
        return "\(sec)s"
    }
}
