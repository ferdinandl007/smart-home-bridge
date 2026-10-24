# SMART+ HomeKit Bridge

A small native macOS menu bar app that brings LEDVANCE / OSRAM SMART+ Wi-Fi lights into Apple Home using the HomeKit Accessory Protocol.

Sign in to your SMART+ account once. The app imports device keys, discovers lights on your network, and adds supported lights to one HomeKit bridge. Account inventory refreshes every two minutes; network discovery continues in the background. Known lights reconnect automatically when powered on, and new supported account lights are added without pairing the bridge again.

## Install

1. Download the ZIP for your Mac from **Releases**, unzip it, and move **SMART+ HomeKit Bridge.app** to Applications.
2. Open the app and choose **HomeKit setup…** from its house icon in the menu bar.
3. Select **Connect account…** and enter your **SMART+ app** email/password, country calling code, and account region. This is not your Apple Account password. Apple-only sign-in is not supported by the account API. You can alternatively enter each light's local key.
4. Allow Local Network access if macOS asks.
5. In **Apple Home**, scan the app's real pairing QR code: Home → + → Add Accessory. Home may identify this as an uncertified accessory; choose **Add Anyway** if offered.
6. In **Settings…**, enable **Launch at login** on the Mac that will host the bridge. **Keep Mac awake while bridging** prevents idle system sleep while allowing the display to sleep.

Closing the settings window leaves the app running in the menu bar. Quitting, shutting down, disconnecting the network, or manually putting the Mac to sleep makes the bridge unavailable. Automatic startup occurs **after user login**, not before login or before FileVault unlock. A supported Apple home hub is required for remote access and hub-based automations.

Use only one running instance of this bridge on your home network. For a permanent Mac mini installation, sign in on the mini and pair its bridge there; quit the temporary bridge on your other Mac. Each Mac creates its own HomeKit identity and pairing code.

The release is ad-hoc signed, not Apple notarized. macOS may require approval in **System Settings → Privacy & Security → Open Anyway**. The app bundles its runtime; Node, Python, Homebridge, and Home Assistant do not need to be installed by the user.

## Controls

The menu shows connectivity, light count, login, and HomeKit setup. All light controls live in Apple Home.

HomeKit exposes power, brightness, supported RGB hue/saturation, actual tunable-white temperature where reported, device scene mode, and advertised boolean features such as do-not-disturb. RGBW lights have an explicit **White mode** switch. Selecting zero saturation also selects the dedicated white channel; selecting a color returns to RGB mode. Fixed-white RGBW devices do not pretend to have adjustable white temperature.

The bridge automatically imports supported account lights as they come online and refreshes account inventory every two minutes. Missing telemetry is unknown. Normal light writes are verified against fresh local reads; commands never fall back to cloud control.

This release supports Tuya-protocol **Wi-Fi lights** (3.1–3.5). Zigbee, Bluetooth-only, Matter commissioning, cameras, plugs, and sensors are not implemented. Vendor-specific schedules, countdown configuration, arbitrary effect editors, and music streaming remain in SMART+. Apple Home does not have native UI for every vendor feature. The engine includes validated feature/scene operations for future integrations, but the deliberately simple Mac app does not expose a light-control or expert editor. Tunable-white models currently assume 2700–6500 K and may need calibration.

## Storage and privacy

The app does not use Keychain. At your request, it stores the account email/password, local device keys, and capability data in **unencrypted private local files** under:

`~/Library/Application Support/Smart Home Bridge/`

The directory is restricted to your macOS user (`0700`); credential files are `0600`. HomeKit pairing state is kept in that directory and must remain private. File permissions protect against other ordinary user accounts, not malware or administrators on your Mac. The account login enables automatic retrieval of keys for future lights. No credentials, device identities, pairing codes, or personal configuration are embedded in source or release binaries.

The app has no browser administration server. Its Swift interface communicates with the bundled bridge engine over private pipes. The HomeKit service listens on TCP 51847; local Tuya discovery listens on UDP 6666, 6667, and 7000. The app contacts the LEDVANCE/Tuya account API to synchronize devices; light control stays on the LAN.

The private mobile account API is unofficial and could change. Shared or Apple-only accounts may need a SMART+ app password or manually supplied local keys. Device resets can change local keys; account refresh updates them. Some lights permit only one local connection, so close other integrations or SMART+ if a connection is refused.

## Build

Requires macOS 15+, a Swift 6.2+ toolchain, and npm available for dependency installation.

```sh
scripts/build-app.sh
```

The build script downloads the official Node.js 24.22.1 runtime for the host architecture, verifies its published SHA-256 checksum, compiles the Swift app, bundles locked dependencies, signs the bundle ad hoc, and writes a distributable ZIP and checksum under `dist/`. Build on Apple silicon for arm64 or on Intel for x86_64.

```sh
npm ci --prefix Bridge --ignore-scripts
npm test --prefix Bridge
swift test -c release
```

The Swift tests use Vision to decode the actual Core Image QR output and verify it contains the original HomeKit setup URI with a proper quiet zone. Node tests cover protocol framing, missing telemetry, capability detection, scalar validation, light conversions, and scene construction. Physical-device and Apple Home acceptance are separate from these automated tests.

## Architecture

- SwiftUI menu bar app, native settings window, ServiceManagement startup, and idle-sleep assertion.
- HAP-NodeJS advertises a persistent bridge with stable device identities and standard HomeKit characteristics.
- TuyAPI handles encrypted local connections; commands serialize per light.
- UDP discovery handles both classic and Tuya 3.5 authenticated announcements and DHCP address changes.
- A session-cached account importer discovers future lights without logging in again on every refresh.

MIT licensed. See [third-party notices](../THIRD-PARTY-NOTICES.md). Not affiliated with Apple, LEDVANCE, OSRAM, or Tuya.

The app was previously called Smart Home Bridge. Its internal bundle identifier and private storage location are preserved so existing logins and HomeKit pairings survive the rename. The HomeKit bridge manufacturer is HomeKit Bridge; physical lights retain their actual manufacturer.
