#!/usr/bin/env bash
# Creates a permanent virtual audio input, "System sound (Aura)", that carries
# everything this computer plays. Browsers can open it like a microphone, so
# Aura can share all system sound without the tab/screen picker.
#
#   npm run setup:audio            install (Linux + PipeWire)
#   npm run setup:audio -- --remove   uninstall
set -euo pipefail

CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pipewire/pipewire.conf.d"
CONF="$CONF_DIR/aura-system-sound.conf"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This setup is for Linux. On Windows use 'Entire screen' + 'Share system audio' in the share dialog;"
  echo "on macOS install BlackHole (https://existential.audio/blackhole/)."
  exit 1
fi
if ! command -v pipewire >/dev/null 2>&1; then
  echo "PipeWire not found. Aura's system-sound setup requires PipeWire." >&2
  exit 1
fi

restart() {
  echo "Restarting PipeWire (sound pauses for a moment)…"
  systemctl --user restart pipewire pipewire-pulse wireplumber 2>/dev/null || systemctl --user restart pipewire
}

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$CONF"
  restart
  echo "Removed \"System sound (Aura)\"."
  exit 0
fi

mkdir -p "$CONF_DIR"
cat > "$CONF" <<'CONF'
# Added by Aura (scripts/setup-audio.sh). Delete this file to remove.
context.modules = [
  { name = libpipewire-module-loopback
    args = {
      node.description = "System sound (Aura)"
      capture.props = {
        node.name = "aura_system_capture"
        node.description = "Aura capture"
        # Record what the default output device is playing.
        stream.capture.sink = true
        node.passive = true
        audio.position = [ FL FR ]
      }
      playback.props = {
        node.name = "aura_system_sound"
        node.description = "System sound (Aura)"
        media.class = "Audio/Source"
        audio.position = [ FL FR ]
        # Never become the default microphone.
        priority.session = 1
        priority.driver = 1
      }
    }
  }
]
CONF
restart
sleep 1
if command -v wpctl >/dev/null && wpctl status | grep -q "System sound (Aura)"; then
  echo "Installed: \"System sound (Aura)\" is available."
else
  echo "Config written to $CONF, but the device isn't visible yet. Try logging out and back in." >&2
fi
