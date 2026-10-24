import Testing
@testable import SmartHomeBridge
@MainActor @Test func firewallAssessmentUsesActualRuleNotPairing() {
    let blocked=FirewallAccess.assess(global:"Firewall is enabled. (State = 1)",application:"Incoming connection to helper is blocked.",managed:true)
    #expect(FirewallAccess.assess(global:"State = 1",application:"is permitted.",managed:true,listed:false).state == .unknown)
    #expect(blocked.state == .blocked)
    #expect(blocked.detail.contains("administrator"))
    #expect(FirewallAccess.assess(global:"Firewall is enabled. (State = 1)",application:"",managed:false).state == .unknown)
    #expect(FirewallAccess.assess(global:"Firewall is enabled. (State = 1)",application:"Incoming connection to helper is permitted.",managed:false).state == .allowed)
    #expect(FirewallAccess.assess(global:"Firewall is disabled. (State = 0)",application:"is blocked.",managed:false).state == .allowed)
}
