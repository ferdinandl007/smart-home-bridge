#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
app="${PWD}/dist/SMART+ HomeKit Bridge.app"
runtime_version="24.22.1"
case "$(uname -m)" in
  arm64) runtime_arch="arm64" ;;
  x86_64) runtime_arch="x64" ;;
  *) print -u2 "Unsupported Mac architecture"; exit 1 ;;
esac
runtime_dir="${PWD}/.runtime/node-v${runtime_version}-darwin-${runtime_arch}"
if [[ ! -x "$runtime_dir/bin/node" ]]; then
  mkdir -p .runtime
  archive="node-v${runtime_version}-darwin-${runtime_arch}.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v${runtime_version}/${archive}" -o ".runtime/${archive}"
  curl -fsSL "https://nodejs.org/dist/v${runtime_version}/SHASUMS256.txt" -o .runtime/SHASUMS256.txt
  (cd .runtime; awk -v name="$archive" '$2==name' SHASUMS256.txt | shasum -a 256 -c)
  tar -xzf ".runtime/${archive}" -C .runtime
fi
node_binary="$runtime_dir/bin/node"
npm ci --prefix Bridge --ignore-scripts --registry=https://registry.npmjs.org
swift build -c release
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/Runtime" "$app/Contents/Resources/Bridge"
cp .build/release/SmartHomeBridge "$app/Contents/MacOS/SmartHomeBridge"
cp "$node_binary" "$app/Contents/Resources/Runtime/node"
cp Bridge/*.mjs Bridge/package.json Bridge/package-lock.json "$app/Contents/Resources/Bridge/"
cp -R Bridge/node_modules "$app/Contents/Resources/Bridge/"
cp LICENSE THIRD-PARTY-NOTICES.md "$app/Contents/Resources/"
cp "$runtime_dir/LICENSE" "$app/Contents/Resources/NODE-LICENSE"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>SMART+ HomeKit Bridge</string>
<key>CFBundleDisplayName</key><string>SMART+ HomeKit Bridge</string>
<key>CFBundleIdentifier</key><string>com.local.SmartHomeBridge</string>
<key>CFBundleExecutable</key><string>SmartHomeBridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.5</string>
<key>CFBundleVersion</key><string>5</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSLocalNetworkUsageDescription</key><string>Discover and control your SMART+ lights and make them available to Apple Home on your local network.</string>
<key>NSBonjourServices</key><array><string>_hap._tcp</string></array>
</dict></plist>
PLIST
codesign --force --sign - "$app/Contents/Resources/Runtime/node"
codesign --force --deep --sign - "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "${PWD}/dist/SMART-Plus-HomeKit-Bridge-macOS-$(uname -m).zip"
(cd dist; shasum -a 256 "SMART-Plus-HomeKit-Bridge-macOS-$(uname -m).zip" > "SHA256SUMS-$(uname -m).txt")
print "Built: $app"
