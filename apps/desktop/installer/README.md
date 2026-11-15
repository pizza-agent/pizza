# macOS installer artwork

`background.png` is the committed, Retina-resolution DMG background (720 × 520
points, 1440 × 1040 pixels). Normal builds use it directly and need no additional
image tools or generation step.

All installation instructions appear in English first, with a smaller Chinese
translation underneath. Keep both languages together when editing the artwork.
The layout starts directly with the drag-to-install step and leaves generous
space around the icons. The second step is a single bilingual instruction for
first-time installations, followed by the terminal command.

To update the artwork on macOS, edit and run:

```sh
swift scripts/generate-dmg-background.swift
```

The app and Applications folder are real Finder icons, positioned by
`../tauri.macos.conf.json`. Keep their positions and the background arrow aligned.
The window height includes 28 points for Finder's title bar.

The bottom panel tells users to copy Pizza into Applications, then manually run
`xattr -cr /Applications/Pizza.app` in Terminal before opening it for the first
time. This command is displayed as instructions; the installer does not run it.

The release workflow sets `TAURI_BUNDLER_DMG_IGNORE_CI=true` because Tauri normally
skips Finder background and icon layout customization when `CI=true`.
