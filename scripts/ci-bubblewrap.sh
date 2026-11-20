#!/bin/sh
# CI only: install bubblewrap and allow unprivileged user namespaces (Ubuntu 24.04's AppArmor restricts them), so
# the reviewer's isolation probe (packages/review/src/bwrap-shell.adapter.test.ts) runs on the required check: it
# fails rather than skips when CI is set. Never run it on a workstation: it changes the host's sysctl.
set -eu
apt-get update -q
apt-get install -y -q bubblewrap
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
bwrap --unshare-all --ro-bind / / true
