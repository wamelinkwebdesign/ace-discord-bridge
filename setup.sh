#!/bin/bash
# Ace Discord Bridge - Setup Script
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Ace Discord Bridge Setup"
echo "========================"
echo ""

# 1. Install dependencies
echo "[1/4] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --quiet
echo "Done"

# 2. Check config
echo ""
echo "[2/4] Checking config..."
if [ ! -f "$SCRIPT_DIR/config.json" ]; then
    echo "config.json not found. Creating from example..."
    cp "$SCRIPT_DIR/config.example.json" "$SCRIPT_DIR/config.json"
    echo "Please edit config.json with your Discord bot token, user ID, guild ID, and channel IDs."
    echo "Then re-run this script."
    exit 1
else
    echo "config.json found"
fi

# 3. Check Claude Code
echo ""
echo "[3/4] Checking Claude Code..."
if command -v claude &> /dev/null; then
    echo "Claude Code found: $(claude --version 2>/dev/null || echo 'installed')"
else
    echo "Claude Code not found in PATH."
    echo "Install it from: https://docs.claude.com/en/docs/claude-code"
    exit 1
fi

# 4. Install launchd service (macOS only)
echo ""
echo "[4/4] Setting up auto-start (macOS)..."
if [[ "$(uname)" == "Darwin" ]]; then
    PLIST_NAME="com.ace.discord-bridge.plist"
    PLIST_SRC="$SCRIPT_DIR/$PLIST_NAME"
    PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

    if [ ! -f "$PLIST_SRC" ]; then
        # Generate plist from example
        NODE_PATH=$(which node)
        sed "s|/path/to/ace-discord-bridge|$SCRIPT_DIR|g" \
            "$SCRIPT_DIR/com.ace.discord-bridge.example.plist" | \
            sed "s|/opt/homebrew/bin/node|$NODE_PATH|g" \
            > "$PLIST_SRC"
        echo "Generated $PLIST_NAME"
    fi

    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl load "$PLIST_DST" 2>/dev/null || true
    echo "Service installed and started"
else
    echo "Skipped (not macOS). Run manually with: npm start"
fi

echo ""
echo "========================"
echo "Setup complete!"
echo ""
echo "Commands:"
echo "  Start:   npm start (or launchctl load ~/Library/LaunchAgents/com.ace.discord-bridge.plist)"
echo "  Stop:    launchctl unload ~/Library/LaunchAgents/com.ace.discord-bridge.plist"
echo "  Logs:    tail -f /tmp/ace-discord-bridge.log"
echo "  Errors:  tail -f /tmp/ace-discord-bridge-error.log"
