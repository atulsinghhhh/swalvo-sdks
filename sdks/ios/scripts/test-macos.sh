#!/usr/bin/env bash
# Runs the SwalvoRTC test suite on macOS with SwiftPM.
#
# With a full Xcode selected (`xcode-select -p` points into Xcode.app),
# plain `swift test` works and this script just runs it.
#
# With only the Command Line Tools, swift-testing's Testing.framework ships
# in the CLT but SwiftPM does not add its search paths, so they are passed
# here. (XCTest is not part of the Command Line Tools at all, which is why
# the suite uses swift-testing.)
set -euo pipefail
cd "$(dirname "$0")/.."

DEV="$(xcode-select -p)"
if [[ "$DEV" == *"CommandLineTools"* ]]; then
  F="$DEV/Library/Developer/Frameworks"
  L="$DEV/Library/Developer/usr/lib"
  exec swift test \
    -Xswiftc -F -Xswiftc "$F" \
    -Xlinker -F -Xlinker "$F" \
    -Xlinker -rpath -Xlinker "$F" \
    -Xlinker -rpath -Xlinker "$L" \
    "$@"
fi
exec swift test "$@"
