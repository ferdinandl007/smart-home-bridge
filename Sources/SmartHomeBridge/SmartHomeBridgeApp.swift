import SwiftUI
import AppKit

@main struct SmartHomeBridgeApp:App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @State private var model=BridgeModel.shared
    var body:some Scene {
        Window("SMART+ HomeKit Bridge",id:"main") {
            SetupView(model:model).onAppear { delegate.model=model;model.start() }
        }
        .defaultSize(width:440,height:440)
        .windowResizability(.contentSize)
        .defaultLaunchBehavior(CommandLine.arguments.contains("--show-window") ? .presented:.suppressed)
        Settings { BridgeSettings(model:model) }
        MenuBarExtra {
            BridgeMenu(model:model).onAppear { delegate.model=model;model.start() }
        } label: { Image(systemName:model.status.running ? "house.fill":"house").accessibilityLabel("SMART+ HomeKit Bridge") }
    }
}
final class AppDelegate:NSObject,NSApplicationDelegate {
    var model:BridgeModel?
    func applicationDidFinishLaunching(_ notification:Notification) { model=BridgeModel.shared;model?.start() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool { false }
    func applicationWillTerminate(_ notification:Notification) { model?.quit() }
}
struct BridgeMenu:View {
    @Bindable var model:BridgeModel
    @Environment(\.openWindow) private var openWindow
    var body:some View {
        Text(model.status.running ? (model.connected ? "Bridge online":"Bridge online · lights unavailable"):"Bridge offline")
        Text("\(model.lights.filter(\.online).count) connected · \(model.savedNames.count) lights detected")
        Divider()
        Button("HomeKit setup…") { NSApp.activate();openWindow(id:"main") }
        Button(model.accountEmail.isEmpty ? "Log in to SMART+…":"Account login…") { NSApp.activate();openWindow(id:"main");model.showAccount=true }
        SettingsLink { Text("Settings…") }
        Divider()
        Button("Quit SMART+ HomeKit Bridge") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
struct SetupView:View {
    @Bindable var model:BridgeModel
    @State private var showCode=false
    @State private var showTests=false
    private var online:Int { model.lights.filter(\.online).count }
    var body:some View {
        VStack(spacing:20) {
            Image(systemName:model.connected ? "checkmark.circle.fill":"wifi.exclamationmark")
                .font(.system(size:40,weight:.regular)).foregroundStyle(model.connected ? Color.green:Color.secondary)
                .accessibilityHidden(true)
            VStack(spacing:8) {
                Text(!model.status.running && !model.accountEmail.isEmpty ? "Bridge Needs Attention":model.status.paired && model.connected ? "Your Lights Are Connected":"Your Lights, in Apple Home")
                    .font(.title2.weight(.semibold))
                Text(model.accountEmail.isEmpty ? "Connect your SMART+ account to get started.":model.status.paired ? "Control them in Apple Home. We’ll take care of the connection.":"Open Home on your iPhone, tap +, then Add Accessory and scan the code.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal:false,vertical:true)
            }
            if model.accountEmail.isEmpty {
                Button("Connect SMART+ Account") { model.showAccount=true }.buttonStyle(.borderedProminent).controlSize(.large).disabled(!model.engineReady)
            } else {
                Label("\(online) of \(model.savedNames.count) lights connected",systemImage:model.status.running ? "checkmark.circle":"wifi.slash")
                    .font(.callout).accessibilityLabel("\(online) lights connected, \(model.savedNames.count) detected in your account")
                if !model.status.paired || showCode {
                    if let qr=PairingCode.image(model.status.uri),model.status.running {
                        Image(nsImage:qr).interpolation(.none).resizable().frame(width:190,height:190)
                            .padding(6).background(.white,in:RoundedRectangle(cornerRadius:10)).accessibilityLabel("HomeKit pairing QR code")
                        HStack(spacing:12) {
                            Text(model.status.pincode).font(.system(.body,design:.monospaced)).textSelection(.enabled)
                            Button { NSPasteboard.general.clearContents();NSPasteboard.general.setString(model.status.pincode,forType:.string) } label: { Label("Copy Code",systemImage:"doc.on.doc") }.controlSize(.small)
                        }
                        Text("If Home asks, choose Add Anyway.").font(.caption).foregroundStyle(.secondary)
                    } else { ProgressView("Connecting…") }
                } else {
                    Text("New lights connect automatically.\nThis app keeps running when you close the window.").font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Show Pairing Code") { showCode=true }.buttonStyle(.link)
                }
            }
            if !model.accountEmail.isEmpty {
                DisclosureGroup("Connection & Test",isExpanded:$showTests) {
                    VStack(spacing:12) {
                        Button("Recover Connection") { Task { await model.recoverConnection() } }.disabled(model.busy)
                        HStack {
                            Button("All On") { Task { await model.testAllLights(on:true) } }
                            Button("All Off") { Task { await model.testAllLights(on:false) } }
                        }.disabled(model.busy || !model.engineReady)
                        Text("Changes the power of your bridge’s lights. Unreachable lights are reported.").font(.caption).foregroundStyle(.secondary)
                        if model.busy { ProgressView().controlSize(.small) }
                        if !model.testResult.isEmpty { Text(model.testResult).font(.callout).multilineTextAlignment(.center) }
                    }.padding(.top,10)
                }
            }
            if let error=model.error {
                Text(error).font(.callout).foregroundStyle(.red).multilineTextAlignment(.center).textSelection(.enabled)
                Button("Update Account Login") { model.showAccount=true }
            }
            if !model.engineReady { ProgressView("Starting bridge…").controlSize(.small) }
        }
        .padding(32).frame(width:400).fixedSize(horizontal:false,vertical:true)
        .sheet(isPresented:$model.showAccount) { AccountView(model:model) }
    }
}
struct BridgeSettings:View {
    @Bindable var model:BridgeModel
    var body:some View {
        Form {
            Section("Account") {
                LabeledContent("SMART+",value:model.accountEmail.isEmpty ? "Not connected":model.accountEmail)
                Button("Update Account Login…") { model.showAccount=true }
                Text("Login and device keys are saved in private local files on this Mac. Keychain is not used.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Availability") {
                Toggle("Launch at login",isOn:Binding(get:{model.loginEnabled},set:{model.setLogin($0)}))
                Toggle("Keep Mac awake while bridging",isOn:Binding(get:{model.keepAwake},set:{model.setKeepAwake($0)}))
                Text("Starts after you log in. The display can sleep; manual sleep or shutdown disconnects the bridge.").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped).frame(width:460,height:300)
            .sheet(isPresented:$model.showAccount) { AccountView(model:model) }
    }
}
struct AccountView:View {
    @Bindable var model:BridgeModel
    @Environment(\.dismiss) private var dismiss
    @State private var email=""
    @State private var password=""
    @State private var country="41"
    @State private var region="EU"
    @State private var advanced=false
    var body:some View {
        VStack(alignment:.leading,spacing:20) {
            Label("Connect your SMART+ account",systemImage:"lightbulb.2").font(.title2.weight(.semibold))
            Text("All supported lights are imported automatically. New lights are checked every 2 minutes.").foregroundStyle(.secondary)
            Form {
                TextField("Email",text:$email).textContentType(.username)
                SecureField("SMART+ password",text:$password).textContentType(.password)
                DisclosureGroup("Account region: \(region) · +\(country)",isExpanded:$advanced) {
                    TextField("Country calling code",text:$country)
                    Picker("Region",selection:$region) { Text("Europe").tag("EU");Text("United States").tag("US");Text("China").tag("CN");Text("India").tag("IN") }
                }
            }
            Text("Use your SMART+ password, not your Apple password. Saved privately on this Mac so new lights connect automatically.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Cancel") { password="";dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button("Connect account") {
                    let secret=password;password=""
                    Task { await model.account(email:email,password:secret,country:country,region:region) }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(email.isEmpty || password.isEmpty || model.busy)
            }
        }.padding(28).frame(width:470).interactiveDismissDisabled(model.busy)
            .onAppear { email=model.accountEmail }.onDisappear { password="" }
    }
}
