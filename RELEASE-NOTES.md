SMART+ HomeKit Bridge 1.0.4 improves connection recovery and troubleshooting.

- A compact Connection & Test section in setup offers Recover Connection, All On, and All Off.
- Recovery restarts the helper and reconnects saved lights without deleting Apple Home pairing.
- Test commands show how many lights confirmed the change and how many failed.
- Device reads have a deadline, so an unresponsive light cannot indefinitely block later commands.
- Reconnecting updates the existing accessory instead of replacing its HomeKit handlers.
- Single-instance locks and parent-process monitoring prevent duplicate or orphan helpers.
- The setup status no longer treats an old pairing as proof that lights are reachable.

The existing Apple Home identity and login are preserved. This release remains for compatible SMART+ Wi-Fi bulbs and light strips on Apple silicon Macs running macOS 15+.
