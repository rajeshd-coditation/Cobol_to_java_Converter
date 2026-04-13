#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────
# COBOL-to-Java Converter — run.sh
# ──────────────────────────────────────────────
# Usage:
#   ./run.sh              # build libcobj + start web UI
#   ./run.sh build        # only build the Java library
#   ./run.sh serve        # only start the web UI server
#   ./run.sh clean        # clean Gradle build artifacts
#   ./run.sh stop         # stop the running web UI server
#   ./run.sh status       # check if server is running
# ──────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIBCOBJ_DIR="$ROOT_DIR/opensourcecobol4j/libcobj"
WEBUI_DIR="$ROOT_DIR/opensourcecobol4j/tools/web-ui"
PORT=3000

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Preflight checks ────────────────────────
check_deps() {
    command -v java  >/dev/null 2>&1 || error "Java is not installed. Install JDK 11+."
    command -v node  >/dev/null 2>&1 || error "Node.js is not installed. Install Node 18+."
    command -v npm   >/dev/null 2>&1 || error "npm is not installed."
}

# ── Build the libcobj Java library ───────────
build() {
    info "Building libcobj (Java library)..."
    cd "$LIBCOBJ_DIR"
    chmod +x gradlew
    ./gradlew build -x pmdMain -x pmdTest -x spotbugsMain -x spotbugsTest -x spotlessCheck
    info "Build successful — JAR at: $LIBCOBJ_DIR/app/build/libs/libcobj.jar"
}

# ── Install web UI dependencies ──────────────
install_deps() {
    if [ ! -d "$WEBUI_DIR/node_modules" ]; then
        info "Installing web UI dependencies..."
        cd "$WEBUI_DIR"
        npm install
    fi
}

# ── Start the web UI server ──────────────────
serve() {
    install_deps

    # Check if already running
    if lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
        warn "Port $PORT is already in use."
        echo "  Run './run.sh stop' first, or visit http://localhost:$PORT"
        return 0
    fi

    # Check .env exists
    if [ ! -f "$WEBUI_DIR/.env" ]; then
        error "Missing $WEBUI_DIR/.env — copy .env.example and fill in your API keys."
    fi

    info "Starting web UI server on http://localhost:$PORT ..."
    cd "$WEBUI_DIR"
    node server.js &
    SERVER_PID=$!
    echo "$SERVER_PID" > "$WEBUI_DIR/.server.pid"

    # Wait for server to be ready
    for i in $(seq 1 10); do
        if curl -s http://localhost:$PORT >/dev/null 2>&1; then
            info "Server is ready at http://localhost:$PORT (PID: $SERVER_PID)"
            return 0
        fi
        sleep 1
    done
    warn "Server started but may still be initializing. Check http://localhost:$PORT"
}

# ── Stop the server ──────────────────────────
stop() {
    if [ -f "$WEBUI_DIR/.server.pid" ]; then
        PID=$(cat "$WEBUI_DIR/.server.pid")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            info "Server stopped (PID: $PID)."
        else
            info "Server was not running."
        fi
        rm -f "$WEBUI_DIR/.server.pid"
    else
        # Fallback: kill by port
        PIDS=$(lsof -t -i:$PORT 2>/dev/null || true)
        if [ -n "$PIDS" ]; then
            kill $PIDS 2>/dev/null
            info "Stopped process(es) on port $PORT."
        else
            info "No server running on port $PORT."
        fi
    fi
}

# ── Show status ──────────────────────────────
status() {
    if lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
        info "Server is running on port $PORT"
        lsof -i :$PORT -sTCP:LISTEN
    else
        info "Server is not running."
    fi
}

# ── Clean build artifacts ────────────────────
clean() {
    info "Cleaning build artifacts..."
    cd "$LIBCOBJ_DIR"
    ./gradlew clean
    info "Clean complete."
}

# ── Main ─────────────────────────────────────
check_deps

case "${1:-all}" in
    build)  build ;;
    serve)  serve ;;
    stop)   stop ;;
    status) status ;;
    clean)  clean ;;
    all)
        build
        serve
        ;;
    *)
        echo "Usage: $0 {build|serve|stop|status|clean|all}"
        exit 1
        ;;
esac
