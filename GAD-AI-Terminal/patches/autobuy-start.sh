#!/bin/sh
# Startup script for autobuy — runs patches then starts the service
node /patches/autobuy.patch.js 2>&1 || true
exec npm --workspace services/autobuy start
