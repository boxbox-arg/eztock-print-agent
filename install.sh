#!/usr/bin/env bash
set -euo pipefail

AGENT_NAME="eztock-print-agent"
BIN_DIR="/usr/local/bin"
CONF_DIR="${HOME}/.eztock-agent"
SERVICE_FILE="${AGENT_NAME}.service"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
VERSION="0.1.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[x]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[*]${NC} $1"; }

echo ""
echo "============================================"
echo "  Eztock Print Agent v${VERSION} — Installer"
echo "============================================"
echo ""

# ── Detect arch ──────────────────────────────────────
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
  *)       err "Arquitectura no soportada: $ARCH (se requiere x86_64 o aarch64)" ;;
esac

OS=$(uname -s)
case "$OS" in
  Linux)  OS="linux" ;;
  *)      err "Sistema operativo no soportado: $OS (se requiere Linux)" ;;
esac

info "Detectado: ${OS}-${ARCH}"
echo ""

# ── Prerequisites ────────────────────────────────────
# CUPS (optional — for printer discovery and PDF printing)
if ! command -v lpstat &>/dev/null; then
  warn "CUPS no encontrado. Instalá: sudo apt install cups (o equivalente)"
  warn "Sin CUPS, el discovery de impresoras no funcionará."
else
  log "CUPS detectado: $(lpstat -v 2>/dev/null | wc -l) impresora(s)"
fi

echo ""

# ── Copy binary ──────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY_SRC="${SCRIPT_DIR}/${AGENT_NAME}"

if [ -f "${BINARY_SRC}" ]; then
  log "Copiando binario desde ${BINARY_SRC} a ${BIN_DIR}/${AGENT_NAME}"
  sudo cp "${BINARY_SRC}" "${BIN_DIR}/${AGENT_NAME}"
  sudo chmod +x "${BIN_DIR}/${AGENT_NAME}"
else
  err "Binario no encontrado en ${BINARY_SRC}. Asegurate de tener el binario compilado al lado de este script."
fi

log "Binario instalado: ${BIN_DIR}/${AGENT_NAME}"
echo ""

# ── Config directory ─────────────────────────────────
if [ ! -d "${CONF_DIR}" ]; then
  mkdir -p "${CONF_DIR}"
  log "Directorio de configuración creado: ${CONF_DIR}"
else
  info "Directorio de configuración ya existe: ${CONF_DIR}"
fi

# Create default .env if it doesn't exist
if [ ! -f "${CONF_DIR}/.env" ]; then
  cat > "${CONF_DIR}/.env" << 'EOF'
# Eztock Print Agent Configuration
# Obtené estos valores desde el panel Eztock (Sección Impresión > Agentes)

AGENT_ID=
AGENT_ORGANIZATION_ID=
AGENT_BRANCH_ID=
AGENT_PAIRING_TOKEN=
AGENT_BACKEND_URL=https://api.eztock.com
AGENT_WS_URL=wss://api.eztock.com/ws/print-agent
AGENT_HTTP_PORT=9100
AGENT_LOG_LEVEL=info
EOF
  log "Archivo .env de ejemplo creado en ${CONF_DIR}/.env"
  warn "Editá ${CONF_DIR}/.env con los IDs de tu agente antes de iniciar."
else
  info "Archivo .env ya existe, no se sobrescribe."
fi

echo ""

# ── User groups ──────────────────────────────────────
info "Agregando usuario a grupos de impresión..."

for group in dialout lp; do
  if getent group "$group" &>/dev/null; then
    if id -nG "$USER" | grep -qw "$group"; then
      info "Usuario ya en grupo $group"
    else
      sudo usermod -a -G "$group" "$USER"
      log "Usuario agregado al grupo $group"
    fi
  else
    info "Grupo $group no existe, omitiendo"
  fi
done

echo ""

# ── systemd user service ─────────────────────────────
info "Instalando systemd user service..."

mkdir -p "${SYSTEMD_USER_DIR}"

SERVICE_SRC="${SCRIPT_DIR}/${SERVICE_FILE}"
if [ -f "${SERVICE_SRC}" ]; then
  cp "${SERVICE_SRC}" "${SYSTEMD_USER_DIR}/${SERVICE_FILE}"
else
  # Generate service file inline
  cat > "${SYSTEMD_USER_DIR}/${SERVICE_FILE}" << SERVICE_EOF
[Unit]
Description=Eztock Print Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BIN_DIR}/${AGENT_NAME}
Restart=always
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=10
NoNewPrivileges=yes
PrivateTmp=yes

StandardOutput=journal
StandardError=journal
SyslogIdentifier=eztock-print-agent

EnvironmentFile=-${CONF_DIR}/.env

[Install]
WantedBy=default.target
SERVICE_EOF
fi

log "Service instalado: ${SYSTEMD_USER_DIR}/${SERVICE_FILE}"

systemctl --user daemon-reload
systemctl --user enable "${AGENT_NAME}"
systemctl --user start "${AGENT_NAME}" 2>/dev/null || warn "No se pudo iniciar el servicio. Revisá la configuración en ${CONF_DIR}/.env"

# Enable lingering so service starts at boot (not just login)
loginctl enable-linger "$USER" 2>/dev/null || warn "No se pudo habilitar lingering (necesitás privilegios). Ejecutá manualmente: sudo loginctl enable-linger $USER"

echo ""

# ── Verify ───────────────────────────────────────────
sleep 2

if systemctl --user is-active --quiet "${AGENT_NAME}" 2>/dev/null; then
  log "Servicio activo y corriendo"
  echo ""
  info "Endpoints disponibles:"
  info "  http://localhost:9100/         — Panel de estado"
  info "  http://localhost:9100/status   — Estado JSON"
  info "  http://localhost:9100/health   — Health check"
  info "  http://localhost:9100/printers — Impresoras"
  echo ""
  info "Logs: journalctl --user -u ${AGENT_NAME} -f"
else
  warn "El servicio no está activo. Revisá los logs:"
  info "  journalctl --user -u ${AGENT_NAME} -n 50"
fi

echo ""
echo "============================================"
echo "  Instalación completa"
echo "============================================"
echo ""
info "Próximos pasos:"
info "  1. Completá ${CONF_DIR}/.env con los IDs del panel Eztock"
info "  2. Reiniciá: systemctl --user restart ${AGENT_NAME}"
info "  3. Verificá: curl http://localhost:9100/health"
echo ""

# ── Restart warning ──────────────────────────────────
if ! systemctl --user is-active --quiet "${AGENT_NAME}" 2>/dev/null; then
  echo ""
  warn "============================================"
  warn "  EL SERVICIO NO ESTÁ INICIADO"
  warn "  Completá la configuración y luego:"
  warn "  systemctl --user restart ${AGENT_NAME}"
  warn "============================================"
  echo ""
  exit 1
fi
