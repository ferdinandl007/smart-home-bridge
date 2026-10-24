import AppKit
import Foundation
import Darwin
import Observation
import ServiceManagement
import IOKit.pwr_mgt

struct FoundDevice: Identifiable {
    let id: String
    var ip: String
    var version: String
    var lastSeen: Date
}
struct LightState: Identifiable {
    let id: String
    var name: String
    var ip: String
    var online = false
    var on: Bool?
    var brightness: Double?
    var hue: Double?
    var saturation: Double?
    var error = ""
}
struct BridgeStatus {
    var running = false
    var paired = false
    var pincode = ""
    var uri = ""
    var count = 0
}
enum BridgeFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { text } else { "Bridge error" } }
}

@Observable final class BridgeModel {
    static let shared = BridgeModel()
    var accountEmail = ""
    var keepAwake = UserDefaults.standard.object(forKey:"keepAwake") as? Bool ?? true
    private var powerAssertion:IOPMAssertionID = 0
    private var credentials:[String:Any]?
    var found: [FoundDevice] = []
    var lights: [LightState] = []
    var status = BridgeStatus()
    var engineReady = false
    var busy = false
    var scanning = false
    var message = "Starting the local bridge…"
    var error: String?
    var showAccount = false
    var showManual = false
    var selectedDeviceID = ""
    var advancedDeviceID:String?
    var advanced:[String:Any] = [:]
    var loginEnabled = SMAppService.mainApp.status == .enabled
    var savedNames: [String:String] = [:]
    private var saved: [[String:Any]] = []
    private var engine: Process?
    private var input: FileHandle?
    private var outputBuffer = Data()
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    private var timeouts: [String: Task<Void,Never>] = [:]
    private var connecting: Set<String> = []
    private var terminating = false
    private var restartAttempt = 0
    private var started = false
    private var recovering = false
    private var instanceLock:Int32 = -1
    var testResult = ""
    var connected:Bool { engineReady && status.running && lights.contains(where: \.online) }

    init() {
        do { saved = try CredentialStore.load(); credentials = try CredentialStore.loadAccount(); accountEmail = credentials?["email"] as? String ?? ""; updateNames() }
        catch { self.error = error.localizedDescription }
    }
    func start() {
        guard !started else { return }
        started = true
        startEngine()
    }
    private func updateNames() {
        savedNames = Dictionary(saved.compactMap { d in
            guard let id=d["id"] as? String, let name=d["name"] as? String else { return nil }
            return (id,name)
        }, uniquingKeysWith: { _, new in new })
    }
    private func persist() throws { try CredentialStore.save(saved); updateNames() }
    func startEngine() {
        guard engine?.isRunning != true else { return }
        if instanceLock < 0 {
            let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appending(path:"Smart Home Bridge")
            try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let fd=Darwin.open(directory.appending(path:"app.lock").path,O_CREAT|O_RDWR|O_CLOEXEC,0o600)
            guard fd >= 0, flock(fd,LOCK_EX|LOCK_NB)==0 else { if fd >= 0 { Darwin.close(fd) };error="Another copy of the bridge is running. Quit it before opening this copy.";return }
            instanceLock=fd
        }
        terminating = false
        engineReady = false
        outputBuffer = Data()
        let resources = Bundle.main.resourceURL!
        let runtime = resources.appending(path: "Runtime/node")
        let script = resources.appending(path: "Bridge/engine.mjs")
        guard FileManager.default.isExecutableFile(atPath: runtime.path), FileManager.default.fileExists(atPath: script.path) else {
            error = "The app is missing its bundled bridge runtime. Rebuild it using scripts/build-app.sh."
            return
        }
        let process = Process()
        process.executableURL = runtime
        process.arguments = [script.path]
        var environment=ProcessInfo.processInfo.environment
        environment["SHB_PARENT_PID"]=String(ProcessInfo.processInfo.processIdentifier)
        process.environment=environment
        process.currentDirectoryURL = resources.appending(path:"Bridge")
        // The engine communicates only over private pipes; no web server or admin port.
        let incoming = Pipe(), outgoing = Pipe()
        process.standardInput = incoming
        process.standardOutput = outgoing
        process.standardError = FileHandle.nullDevice
        input = incoming.fileHandleForWriting
        outgoing.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data=handle.availableData
            if data.isEmpty { handle.readabilityHandler=nil;return }
            Task { @MainActor [weak self] in self?.receive(data) }
        }
        process.terminationHandler = { [weak self] process in
            let pid=process.processIdentifier
            Task { @MainActor in if self?.engine?.processIdentifier == pid { self?.engineStopped() } }
        }
        do { try process.run(); engine=process }
        catch { self.error = "Could not start the bridge: \(error.localizedDescription)" }
    }
    private func engineStopped() {
        engineReady=false; status.running=false; updatePowerAssertion()
        for (_,t) in timeouts { t.cancel() }; timeouts.removeAll()
        let waiting=pending; pending.removeAll()
        for (_,continuation) in waiting { continuation.resume(throwing:BridgeFailure.message("The bridge engine stopped.")) }
        for index in lights.indices { lights[index].online=false }
        guard !terminating && !recovering else { return }
        error="The bridge engine stopped. Restart it to reconnect your lights."
        if restartAttempt < 1 {
            restartAttempt += 1
            Task { try? await Task.sleep(for:.seconds(2)); if !terminating { startEngine() } }
        }
    }
    private func receive(_ data: Data) {
        guard !data.isEmpty else { return }
        outputBuffer.append(data)
        while let newline=outputBuffer.firstIndex(of:10) {
            let line=outputBuffer.prefix(upTo:newline)
            outputBuffer.removeSubrange(...newline)
            guard let text=String(data:line,encoding:.utf8), text.hasPrefix("@SHB@"),
                  let json=String(text.dropFirst(5)).data(using:.utf8),
                  let event=(try? JSONSerialization.jsonObject(with:json)) as? [String:Any] else { continue }
            handle(event)
        }
    }
    private func handle(_ event: [String:Any]) {
        switch event["event"] as? String {
        case "ready":
            error=nil;engineReady=true; message="Looking for your lights on the local network."
            Task { await restore() }
        case "reply":
            guard let id=event["requestID"] as? String, let continuation=pending.removeValue(forKey:id) else { return }
            timeouts.removeValue(forKey:id)?.cancel()
            if let text=event["error"] as? String { continuation.resume(throwing:BridgeFailure.message(text)) }
            else { continuation.resume(returning:(try? JSONSerialization.data(withJSONObject:event["result"] ?? NSNull(),options:.fragmentsAllowed)) ?? Data("null".utf8)) }
        case "discovered":
            guard let d=event["device"] as? [String:Any], let id=d["id"] as? String, let ip=d["ip"] as? String else { return }
            let device=FoundDevice(id:id,ip:ip,version:d["version"] as? String ?? "3.3",lastSeen:Date())
            if let index=found.firstIndex(where:{$0.id==id}) { found[index]=device } else { found.append(device) }
            if let index=saved.firstIndex(where:{$0["id"] as? String == id}),
               !connecting.contains(id), lights.first(where:{$0.id==id})?.online != true {
                var config=saved[index]; config["ip"]=ip; config["version"]=device.version
                Task { await connect(config,quiet:true) }
            }
        case "accountDevices":
            if let devices=event["devices"] as? [[String:Any]] { importDevices(devices) }
        case "light":
            guard let d=event["light"] as? [String:Any],let id=d["id"] as? String else { return }
            let light=LightState(id:id,name:d["name"] as? String ?? "Light",ip:d["ip"] as? String ?? "",online:d["online"] as? Bool ?? false,on:d["on"] as? Bool,brightness:d["brightness"] as? Double,hue:d["hue"] as? Double,saturation:d["saturation"] as? Double,error:d["error"] as? String ?? "")
            if let index=lights.firstIndex(where:{$0.id==id}) { lights[index]=light } else { lights.append(light) }
        case "bridge": if let _=event["running"] { updateStatus(event) }
        case "notice": message=event["message"] as? String ?? ""
        case "fatal": error=event["message"] as? String
        default: break
        }
    }
    private func updateStatus(_ d:[String:Any]) {
        status=BridgeStatus(running:d["running"] as? Bool ?? false,paired:d["paired"] as? Bool ?? false,pincode:d["pincode"] as? String ?? "",uri:d["uri"] as? String ?? "",count:d["count"] as? Int ?? 0)
        updatePowerAssertion()
    }
    private func request(_ method:String,_ params:[String:Any]=[:],timeout:Double=40) async throws -> Any {
        guard engine?.isRunning == true,let input else { throw BridgeFailure.message("The bridge engine is not running.") }
        let id=UUID().uuidString
        let data=try JSONSerialization.data(withJSONObject:["requestID":id,"method":method,"params":params]) + Data([10])
        let response:Data = try await withCheckedThrowingContinuation { continuation in
            pending[id]=continuation
            timeouts[id]=Task { [weak self] in
                do { try await Task.sleep(for:.seconds(timeout)) } catch { return }
                guard let self,let continuation=pending.removeValue(forKey:id) else { return }
                timeouts.removeValue(forKey:id)
                continuation.resume(throwing:BridgeFailure.message("This operation timed out. Check the light’s power and network connection."))
            }
            do { try input.write(contentsOf:data) }
            catch { pending.removeValue(forKey:id)?.resume(throwing:error);timeouts.removeValue(forKey:id)?.cancel() }
        }
        return try JSONSerialization.jsonObject(with:response,options:.fragmentsAllowed)
    }
    private func restore() async {
        do {
            let configured=saved.filter { $0["ip"] != nil && $0["version"] != nil }
            _ = try await request("restore",["devices":configured])
            if let d=try await request("start") as? [String:Any] { updateStatus(d) }
            for config in configured { await connect(config,quiet:true) }
            await scan()
            if let credentials { _ = try await request("account",credentials,timeout:180) }
        } catch { self.error=error.localizedDescription }
    }
    private func importDevices(_ devices:[[String:Any]]) {
        for device in devices {
            guard let id=device["id"] as? String else { continue }
            let index=saved.firstIndex(where:{$0["id"] as? String == id})
            var merged=index.map{saved[$0]} ?? [:]
            let oldKey=merged["key"] as? String
            for (k,v) in device { merged[k]=v }
            if let local=found.first(where:{$0.id==id}) { merged["ip"]=local.ip;merged["version"]=local.version }
            if let index { saved[index]=merged } else { saved.append(merged) }
            if merged["ip"] != nil && (oldKey != merged["key"] as? String || lights.first(where:{$0.id==id})?.online != true) {
                Task { await connect(merged,quiet:true) }
            }
        }
        do { try persist() } catch { self.error=error.localizedDescription }
    }
    func recoverConnection() async {
        guard !busy else { return }
        busy=true;recovering=true;error=nil;testResult="Reconnecting…"
        defer { busy=false;recovering=false }
        let previous=engine
        input?.closeFile();previous?.terminate()
        for _ in 0..<30 { if previous?.isRunning != true { break };try? await Task.sleep(for:.milliseconds(100)) }
        if let previous,previous.isRunning { Darwin.kill(previous.processIdentifier,SIGKILL) }
        for _ in 0..<20 { if previous?.isRunning != true { break };try? await Task.sleep(for:.milliseconds(100)) }
        engine=nil;engineReady=false;status.running=false;connecting.removeAll();found.removeAll();lights.removeAll()
        startEngine()
        for _ in 0..<100 { if connected { break };try? await Task.sleep(for:.milliseconds(200)) }
        testResult=connected ? "Connection restored. Your Apple Home pairing is unchanged.":"Still reconnecting. Check that your lights are powered on and on the same Wi-Fi."
    }
    func testAllLights(on:Bool) async {
        guard !busy else { return };busy=true;defer{busy=false}
        testResult=on ? "Turning all connected lights on…":"Turning all connected lights off…"
        do {
            let results=try await request("allPower",["on":on],timeout:35) as? [[String:Any]] ?? []
            let passed=results.filter{$0["success"] as? Bool == true}.count
            let failed=results.count-passed+max(0,savedNames.count-results.count)
            testResult="\(passed) lights confirmed \(on ? "on":"off")."+(failed>0 ? " \(failed) did not respond.":"")
            if results.isEmpty { testResult="No lights are connected yet. Try Recover Connection." }
        } catch { testResult=error.localizedDescription }
    }
    func refreshEverything() async {
        if credentials != nil { do { _ = try await request("refreshAccount",timeout:180) } catch { self.error=error.localizedDescription } }
        await scan()
    }
    func setKeepAwake(_ enabled:Bool) { keepAwake=enabled;UserDefaults.standard.set(enabled,forKey:"keepAwake");updatePowerAssertion() }
    private func updatePowerAssertion() {
        if keepAwake && status.running && powerAssertion == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,IOPMAssertionLevel(kIOPMAssertionLevelOn),"Keep HomeKit lights available" as CFString,&powerAssertion)
        } else if (!keepAwake || !status.running) && powerAssertion != 0 { IOPMAssertionRelease(powerAssertion);powerAssertion=0 }
    }
    func scan() async {
        guard !scanning else { return }; scanning=true
        defer { scanning=false }
        do {
            _ = try await request("scan")
            message="Found \(found.count) local device\(found.count == 1 ? "" : "s"). \(lights.filter(\.online).count) light\(lights.filter(\.online).count == 1 ? " is" : "s are") connected."
            if let data=try await request("status") as? [String:Any],let bridge=data["bridge"] as? [String:Any] { updateStatus(bridge) }
        } catch { self.error=error.localizedDescription }
    }
    func connect(_ config:[String:Any],quiet:Bool=false) async {
        guard let id=config["id"] as? String,!connecting.contains(id) else { return }
        connecting.insert(id);defer { connecting.remove(id) }
        do {
            guard let verified=try await request("configure",config) as? [String:Any] else { return }
            if let index=saved.firstIndex(where:{$0["id"] as? String == id}) { saved[index]=verified } else { saved.append(verified) }
            try persist()
            if !quiet { message="\(verified["name"] as? String ?? "Light") is connected locally."; showManual=false }
            if let result=try await request("status") as? [String:Any],let bridge=result["bridge"] as? [String:Any] { updateStatus(bridge) }
        } catch { if !quiet { self.error=error.localizedDescription } }
    }
    func addManual(name:String,id:String,ip:String,key:String,version:String) async {
        busy=true; defer { busy=false }
        await connect(["name":name.trimmingCharacters(in:.whitespaces),"id":id.trimmingCharacters(in:.whitespaces),"ip":ip.trimmingCharacters(in:.whitespaces),"key":key.trimmingCharacters(in:.whitespaces),"version":version])
    }
    func account(email:String,password:String,country:String,region:String) async {
        busy=true; defer { busy=false }
        do {
            let account:[String:Any] = ["email":email,"password":password,"countryCode":country,"region":region]
            _ = try await request("account",account,timeout:180)
            try CredentialStore.saveAccount(account);credentials=account;accountEmail=email
            showAccount=false
            message="Your account is connected. New lights will be imported automatically."
            await scan()
        } catch { self.error=error.localizedDescription }
    }
    func features(id:String) async {
        do { if let result=try await request("features",["id":id]) as? [String:Any] { advanced=result } }
        catch { self.error=error.localizedDescription }
    }
    func featureWrite(id:String,featureID:String,value:Any) async {
        do { if let result=try await request("featureWrite",["id":id,"featureID":featureID,"value":value]) as? [String:Any] { advanced=result } }
        catch { self.error=error.localizedDescription }
    }
    func applyScene(id:String,preset:String) async {
        do { if let result=try await request("scene",["id":id,"preset":preset]) as? [String:Any] { advanced=result } }
        catch { self.error=error.localizedDescription }
    }
    func write(id:String,property:String,value:Any) async {
        do { _ = try await request("write",["id":id,"property":property,"value":value]) }
        catch { self.error=error.localizedDescription }
    }
    func setBridge(_ running:Bool) async {
        busy=true;defer{busy=false}
        do { if let d=try await request(running ? "start":"stop") as? [String:Any] { updateStatus(d) } }
        catch { self.error=error.localizedDescription }
    }
    func remove(id:String) async {
        do { _ = try await request("remove",["id":id]);saved.removeAll{$0["id"] as? String == id};try persist();lights.removeAll{$0.id==id};await scan() }
        catch { self.error=error.localizedDescription }
    }
    func setLogin(_ enabled:Bool) {
        do { if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() };loginEnabled=SMAppService.mainApp.status == .enabled }
        catch { self.error=error.localizedDescription }
    }
    func quit() {
        terminating=true
        if powerAssertion != 0 { IOPMAssertionRelease(powerAssertion);powerAssertion=0 }
        input?.closeFile();engine?.terminate()
    }
}

enum CredentialStore {
    private static var directory:URL {
        FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appending(path:"Smart Home Bridge",directoryHint:.isDirectory)
    }
    private static func read(_ name:String) throws -> Data? {
        let file=directory.appending(path:name)
        guard FileManager.default.fileExists(atPath:file.path) else { return nil }
        return try Data(contentsOf:file)
    }
    private static func write(_ data:Data,name:String) throws {
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:directory.path)
        let destination=directory.appending(path:name)
        let temporary=directory.appending(path:".save-"+UUID().uuidString)
        guard FileManager.default.createFile(atPath:temporary.path,contents:data,attributes:[.posixPermissions:0o600]) else { throw BridgeFailure.message("Could not save private local settings.") }
        guard rename(temporary.path,destination.path)==0 else { try? FileManager.default.removeItem(at:temporary);throw BridgeFailure.message("Could not finish saving local settings.") }
    }
    static func load() throws -> [[String:Any]] {
        guard let data=try read("devices.json") else { return [] }
        return (try JSONSerialization.jsonObject(with:data)) as? [[String:Any]] ?? []
    }
    static func save(_ devices:[[String:Any]]) throws { try write(JSONSerialization.data(withJSONObject:devices),name:"devices.json") }
    static func loadAccount() throws -> [String:Any]? {
        guard let data=try read("account.json") else { return nil }
        return (try JSONSerialization.jsonObject(with:data)) as? [String:Any]
    }
    static func saveAccount(_ account:[String:Any]) throws { try write(JSONSerialization.data(withJSONObject:account),name:"account.json") }
}
