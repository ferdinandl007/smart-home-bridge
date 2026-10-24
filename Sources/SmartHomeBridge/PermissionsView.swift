import SwiftUI
import AppKit
import ServiceManagement
import CoreFoundation

struct FirewallAccess {
    enum State { case allowed, blocked, unknown }
    var state:State = .unknown
    var managed=false
    var detail="Not checked yet."
    static func assess(global:String,application:String,managed:Bool,listed:Bool=true)->Self {
        if global.contains("State = 0") { return Self(state:.allowed,managed:managed,detail:"Firewall is off; it is not blocking this bridge.") }
        guard global.contains("State = 1") else { return Self(state:.unknown,managed:managed,detail:"Could not read firewall status. Open System Settings to check it.") }
        if application.contains("is blocked.") { return Self(state:.blocked,managed:managed,detail:managed ? "Incoming connections are blocked by a managed firewall. Ask your administrator to allow the bridge helper.":"Incoming connections to the bridge helper are blocked. Allow them in Firewall Options.") }
        if !listed { return Self(state:.unknown,managed:managed,detail:"Access is not confirmed. No explicit firewall rule was found for this copy of the bridge. Check Firewall Options.") }
        if application.contains("is permitted.") { return Self(state:.allowed,managed:managed,detail:"The firewall reports this helper is permitted. The connection test below checks whether it is reachable.") }
        return Self(state:.unknown,managed:managed,detail:"The helper’s firewall permission could not be verified.")
    }
}

@Observable final class PermissionChecks {
    var firewall=FirewallAccess()
    var checking=false
    private static func output(_ arguments:[String]) async -> String {
        let process=Process();process.executableURL=URL(filePath:"/usr/libexec/ApplicationFirewall/socketfilterfw");process.arguments=arguments
        let pipe=Pipe();process.standardOutput=pipe;process.standardError=pipe
        return await withCheckedContinuation { continuation in
            process.terminationHandler={ _ in
                let data=pipe.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning:String(data:data,encoding:.utf8) ?? "")
            }
            do {try process.run()} catch {continuation.resume(returning:"")}
        }
    }
    func refresh() async {
        guard !checking else {return};checking=true;defer{checking=false}
        let runtime=Bundle.main.resourceURL!.appending(path:"Runtime/node").path
        let global=await Self.output(["--getglobalstate"])
        let application=await Self.output(["--getappblocked",runtime])
        let rules=await Self.output(["--listapps"])
        let listed=rules.components(separatedBy:"\n").contains { $0.hasSuffix(runtime+" ") || $0.hasSuffix(runtime) }
        let managed=CFPreferencesAppValueIsForced("EnableFirewall" as CFString,"com.apple.security.firewall" as CFString) || CFPreferencesAppValueIsForced("globalstate" as CFString,"com.apple.alf" as CFString)
        firewall=FirewallAccess.assess(global:global,application:application,managed:managed,listed:listed)
    }
}

struct PermissionsView:View {
    @Bindable var model:BridgeModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var checks=PermissionChecks()
    @State private var details=false
    var body:some View {
        VStack(alignment:.leading,spacing:18) {
            HStack {Text("Permissions & Connection").font(.title2.weight(.semibold));Spacer();Button("Done"){dismiss()}.keyboardShortcut(.cancelAction)}
            Text("Check what’s ready and what needs your attention.").foregroundStyle(.secondary)
            Form {
                Section("Required") {
                    row("Local network",symbol:model.connected ? "checkmark.circle.fill":"questionmark.circle",detail:model.connected ? "Verified: this app can reach your lights.":"Not verified. This can mean a permission issue, powered-off lights, or a different Wi-Fi network.",good:model.connected) {
                        if !model.connected {Button("Try Again"){Task{await model.scan()}}.disabled(model.scanning || !model.engineReady)}
                        Button("Local Network Settings…"){open("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")}
                    }
                    row("Incoming HomeKit connections",symbol:checks.firewall.state == .allowed ? "checkmark.circle.fill":checks.firewall.state == .blocked ? "exclamationmark.triangle.fill":"questionmark.circle",detail:checks.firewall.detail,good:checks.firewall.state == .allowed) {
                        Button("Firewall Settings…"){open("x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall")}
                    }
                    row("HomeKit connection test",symbol:model.incomingReachable == true ? "checkmark.circle.fill":model.incomingReachable == false ? "exclamationmark.triangle.fill":"questionmark.circle",detail:model.incomingReachable == false ? "HomeKit is running, but incoming network connections are failing. Check Firewall Options and network filters. Your pairing is still saved.":model.incomingReachable == true ? "Passed on this Mac’s network address. Only a command from Apple Home confirms access from your iPhone.":"Waiting for the automatic connection check…",good:model.incomingReachable == true) {EmptyView()}
                    row("Apple Home pairing",symbol:model.status.paired ? "checkmark.circle.fill":"qrcode",detail:model.status.paired ? "Pairing is saved. This alone does not confirm Apple Home can reach the bridge.":"Scan the setup QR code in Apple Home after the connection checks pass.",good:model.status.paired) {EmptyView()}
                }
                Section("Optional") {
                    let status=SMAppService.mainApp.status
                    row("Launch at login",symbol:status == .enabled ? "checkmark.circle.fill":"circle",detail:status == .enabled ? "Enabled.":status == .requiresApproval ? "Approval is needed in Login Items.":"Off. The bridge runs while this app is open.",good:status == .enabled,attention:false) {
                        if status == .notRegistered {Button("Enable"){model.setLogin(true)}}
                        Button("Login Items…"){SMAppService.openSystemSettingsLoginItems()}
                    }
                }
                Section {
                    DisclosureGroup("If access is blocked",isExpanded:$details) {
                        Text("macOS controls permissions. If Local Network access was denied, enable this app in System Settings; macOS may not show the same prompt again. If Firewall Options is locked by a profile, your administrator must approve the helper. Re-pairing Apple Home does not fix a blocked firewall.").font(.callout)
                        Text("Keep the app in a stable installation location. Renaming or moving it can change which firewall rule applies.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }.formStyle(.grouped)
            HStack {if checks.checking {ProgressView().controlSize(.small)};Spacer();Button("Check Again"){Task{await checks.refresh();await model.checkIncomingConnection()}}.disabled(checks.checking)}
        }.padding(22).frame(width:560,height:740)
            .task{await checks.refresh()}
            .onChange(of:scenePhase){_,phase in if phase == .active {Task{await checks.refresh();await model.checkIncomingConnection()}}}
    }
    private func row<Actions:View>(_ title:String,symbol:String,detail:String,good:Bool,attention:Bool=true,@ViewBuilder actions:()->Actions)->some View {
        VStack(alignment:.leading,spacing:7) {
            Label(title,systemImage:symbol).font(.headline).foregroundStyle(good || !attention ? Color.primary:Color.orange)
            Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            HStack{actions()}.controlSize(.small)
        }.padding(.vertical,4)
    }
    private func open(_ value:String){if let url=URL(string:value){NSWorkspace.shared.open(url)}}
}
