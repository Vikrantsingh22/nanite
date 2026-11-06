#!/bin/bash
# Container entrypoint for the `browser` service: virtual display + window manager + VNC + noVNC (port 6080).
set -e
export DISPLAY=:99
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1440x900x24 -ac +extension RANDR &
for i in $(seq 1 50); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 0.2; done
mkdir -p /root/.fluxbox; echo "background: none" > /root/.fluxbox/overlay; echo "session.styleOverlay: /root/.fluxbox/overlay" > /root/.fluxbox/init
fluxbox >/tmp/fluxbox.log 2>&1 &
# VNC is only reachable inside the container; noVNC is published on 127.0.0.1 only by compose.
x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &
# Shared headed Chromium for the headed test config (ws://127.0.0.1:9222/pw); retried until node_modules exist.
(cd /app/e2e && until node bin/headed-server.mjs; do sleep 3; done) >/tmp/headed-server.log 2>&1 &
exec websockify --web /usr/share/novnc 6080 localhost:5900
