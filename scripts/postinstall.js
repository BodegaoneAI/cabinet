// Cross-platform postinstall: macOS-only code signing cleanup for node-pty.
// On non-macOS platforms this is a no-op so Windows/Linux installs don't fail.
if (process.platform === 'darwin') {
  const { execSync } = require('child_process');
  const cmds = [
    'chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    'xattr -d com.apple.provenance node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    'xattr -d com.apple.provenance node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  ];
  for (const cmd of cmds) {
    try { execSync(cmd, { stdio: 'ignore' }); } catch {}
  }
}
