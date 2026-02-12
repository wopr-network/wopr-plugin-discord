#!/bin/sh
# Build @wopr-network/plugin-types if dist/ is missing.
# This is needed because the package is installed from GitHub and
# doesn't have a "prepare" script, so dist/ is not built on install.
TYPES_DIR="node_modules/@wopr-network/plugin-types"
if [ -d "$TYPES_DIR" ] && [ ! -d "$TYPES_DIR/dist" ]; then
  echo "Building @wopr-network/plugin-types..."
  cd "$TYPES_DIR" && npx tsc
fi
