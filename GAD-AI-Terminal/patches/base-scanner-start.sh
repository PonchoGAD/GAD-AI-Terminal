#!/bin/sh
# Startup script for base-scanner — runs patches then starts the service
node /patches/base-scanner.patch.js 2>&1 || true
exec npm --workspace services/base-scanner start
