Smart Home Bridge 1.0.2 adds LEDVANCE / OSRAM SMART+ Wi-Fi lights to Apple Home from a native macOS menu bar app.

- One-time SMART+ email/password login and automatic inventory refresh every two minutes.
- Local encrypted light control, automatic reconnects, and automatic addition of newly discovered supported account lights.
- HomeKit power, brightness, supported RGB and color temperature, additional boolean feature switches, and device scene mode.
- Minimal menu with bridge connectivity, light count, account login, and HomeKit setup. Light controls stay in Apple Home.
- RGBW white-channel mapping and an explicit White mode switch in HomeKit.
- Real HomeKit QR code, generated from the bridge identity and decoder-tested with Vision.
- Launch at login and optional prevention of idle sleep.
- No Keychain prompts. Private, unencrypted local credential files restricted to the signed-in macOS user.

Requires macOS 15 or newer. The arm64 download is for Apple silicon Macs. The runtime is included; no Homebridge or Node installation is required. The ZIP contains no personal credentials or device configuration.

This release is ad-hoc signed and not notarized. macOS may require approval through Privacy & Security. Startup occurs after user login. Each Mac creates a separate HomeKit bridge: for permanent use, quit the temporary bridge, sign in on the Mac mini, and pair that Mac's QR code.

Limitations: Tuya-protocol Wi-Fi lights only; no Zigbee, Bluetooth-only, Matter commissioning, cameras, plugs, or sensors. Vendor-specific schedules, countdown configuration, and effect editors remain in SMART+. Audio-reactive streaming is not implemented. White temperature assumes 2700–6500 K. Apple Home cannot display every vendor setting. Apple Home pairing and basic controls were confirmed on the development Mac. Mac mini operation must be verified on the destination installation.

Validation: 17 bridge tests, two native QR tests, real-account import, five actual lights read over LAN (protocols 3.3 and 3.5), and local HomeKit Bonjour advertisement. These checks do not replace final Apple Home acceptance.
