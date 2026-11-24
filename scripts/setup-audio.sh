#!/usr/bin/env bash
# Creates a permanent virtual audio input, "System sound (Aura)", that carries
# everything this computer plays. Browsers can open it like a microphone, so
# Aura can share all system sound without the tab/screen picker.
#
#   npm run setup:audio                 install
#   npm run setup:audio -- --sync [ms]  install, and play this computer's own
#                                       speakers ms late (default 120) so they
#                                       stay in step with the phones listening
#   npm run setup:audio -- --remove     uninstall (also undoes --sync)
#
# Why --sync: listeners hear the sound after capture, Wi-Fi, their jitter
# buffer and their own speaker path (~80–150 ms on phones), while this
# computer plays it instantly, so in one room the phones sound late. With
# --sync, apps play into a virtual "Speakers (Aura sync)" output that
#   - is captured for Aura straight away (listeners: no extra delay), and
#   - reaches the real speakers ms later (via PipeWire's loopback delay).
# Everything this computer plays is delayed while it's set up (videos, calls).
# Tune ms to the "≈ N ms behind" figure a listening phone shows.
set -euo pipefail

CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pipewire/pipewire.conf.d"
CONF="$CONF_DIR/aura-system-sound.conf"
SYNC_NODE="aura_sync_output"

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
  sleep 1.5
}

# wpctl id of the node with this node.name (empty if none).
node_id() {
  pw-cli ls Node 2>/dev/null | awk -v want="node.name = \"$1\"" '
    /^[[:space:]]*id [0-9]+/ { id = $2; sub(",", "", id) }
    index($0, want) { print id; exit }'
}

# The speakers --sync was set up for (recorded in the config).
previous_speakers() {
  [[ -f "$CONF" ]] && sed -n 's/^# aura-speakers: //p' "$CONF" | head -1
}

MODE=install
SYNC_MS=""
case "${1:-}" in
  --remove) MODE=remove ;;
  --sync)
    SYNC_MS="${2:-120}"
    if ! [[ "$SYNC_MS" =~ ^[0-9]+$ ]] || (( SYNC_MS < 1 || SYNC_MS > 2000 )); then
      echo "--sync takes a delay in milliseconds (1–2000), e.g. --sync 120" >&2
      exit 1
    fi
    ;;
  "") ;;
  *) echo "Unknown option: $1 (use --sync [ms] or --remove)" >&2; exit 1 ;;
esac

if [[ "$MODE" == remove ]]; then
  SPK="$(previous_speakers || true)"
  rm -f "$CONF"
  restart
  if [[ -n "$SPK" ]] && id="$(node_id "$SPK")" && [[ -n "$id" ]]; then wpctl set-default "$id" || true; fi
  echo "Removed \"System sound (Aura)\"."
  exit 0
fi

# Small buffers: ~5 ms instead of the ~21 ms default quantum.
LATENCY="node.latency = 256/48000"

if [[ -n "$SYNC_MS" ]]; then
  # The real speakers: whatever the default output is now (or was, if re-running).
  SPK="$(previous_speakers || true)"
  if [[ -z "$SPK" ]]; then
    SPK="$(wpctl inspect @DEFAULT_AUDIO_SINK@ 2>/dev/null | sed -n 's/.*node.name = "\(.*\)"/\1/p' | head -1)"
  fi
  if [[ -z "$SPK" || "$SPK" == "$SYNC_NODE" ]]; then
    echo "Couldn't find this computer's speakers (default output)." >&2
    exit 1
  fi
  DELAY_SEC="$(awk -v ms="$SYNC_MS" 'BEGIN { printf "%.3f", ms / 1000 }')"
  CAPTURE_TARGET="target.object = \"$SYNC_NODE\""
  SYNC_MODULE="
  # Apps play here; it reaches the real speakers ${SYNC_MS} ms later.
  { name = libpipewire-module-loopback
    args = {
      node.description = \"Speakers (Aura sync)\"
      target.delay.sec = $DELAY_SEC
      capture.props = {
        node.name = \"$SYNC_NODE\"
        node.description = \"Speakers (Aura sync)\"
        media.class = \"Audio/Sink\"
        audio.position = [ FL FR ]
        $LATENCY
      }
      playback.props = {
        node.name = \"aura_sync_playback\"
        node.description = \"Aura sync → speakers\"
        target.object = \"$SPK\"
        # Never fall back to the default output: that is the sync sink itself.
        node.dont-reconnect = true
        audio.position = [ FL FR ]
        $LATENCY
      }
    }
  }"
else
  SPK=""
  # Record what the default output device is playing.
  CAPTURE_TARGET=""
  SYNC_MODULE=""
fi

mkdir -p "$CONF_DIR"
cat > "$CONF" <<CONF
# Added by Aura (scripts/setup-audio.sh). Delete this file to remove.
${SPK:+# aura-speakers: $SPK}
context.modules = [$SYNC_MODULE
  { name = libpipewire-module-loopback
    args = {
      node.description = "System sound (Aura)"
      capture.props = {
        node.name = "aura_system_capture"
        node.description = "Aura capture"
        stream.capture.sink = true
        $CAPTURE_TARGET
        node.passive = true
        audio.position = [ FL FR ]
        $LATENCY
      }
      playback.props = {
        node.name = "aura_system_sound"
        node.description = "System sound (Aura)"
        media.class = "Audio/Source"
        audio.position = [ FL FR ]
        # Never become the default microphone.
        priority.session = 1
        priority.driver = 1
        $LATENCY
      }
    }
  }
]
CONF
restart

if ! (command -v wpctl >/dev/null && wpctl status | grep -q "System sound (Aura)"); then
  echo "Config written to $CONF, but the device isn't visible yet. Try logging out and back in." >&2
  exit 0
fi
if [[ -n "$SYNC_MS" ]]; then
  id="$(node_id "$SYNC_NODE")"
  if [[ -z "$id" ]]; then
    echo "Installed \"System sound (Aura)\", but \"Speakers (Aura sync)\" didn't appear." >&2
    exit 1
  fi
  # Apps must play into the sync sink for the delay to apply.
  wpctl set-default "$id"
  echo "Installed: \"System sound (Aura)\", with this computer's speakers ${SYNC_MS} ms late (in step with listeners)."
  echo "Output is now \"Speakers (Aura sync)\". If you switch outputs (e.g. Bluetooth), run this again."
else
  echo "Installed: \"System sound (Aura)\" is available."
fi
