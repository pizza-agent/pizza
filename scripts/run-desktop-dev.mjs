// Give `cargo run` a real macOS app bundle so the development window has
// its own Dock entry and can be opened independently of the installed app.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const executable = resolve(process.argv[2]);
const bundle = join(dirname(executable), "Pizza Dev.app");
const contents = join(bundle, "Contents");
mkdirSync(join(contents, "MacOS"), { recursive: true });
const target = join(contents, "MacOS", "pizza-gui");
copyFileSync(executable, target);
writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>pizza-gui</string>
<key>CFBundleIdentifier</key><string>ai.pizza.gui.dev</string>
<key>CFBundleName</key><string>Pizza Dev</string>
<key>CFBundleDisplayName</key><string>Pizza Dev</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.4.3</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Pizza needs microphone access for voice input.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict></plist>`);
const child = spawn(target, process.argv.slice(3), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 0; });
