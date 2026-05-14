# Eztock Print Agent

Agente de impresión local para el sistema de stock Eztock.

## Descripción

Binario standalone compilado con Bun que se instala en cada máquina POS para:
- Conectarse al backend vía WebSocket (WSS)
- Ejecutar trabajos de impresión (ESC/POS y PDF)
- Descubrir impresoras locales
- Mantener una cola offline-first con SQLite

## Arquitectura

```
Frontend (React) ↔ Backend (Hono) ↔ Print Agent (Bun binary) ↔ Impresora (USB/Red)
```

## Instalación

### Desarrollo

```bash
# Instalar dependencias
bun install

# Ejecutar en modo desarrollo
bun run dev
```

### Compilación

```bash
# Compilar binario standalone
bun run build

# Resultado: dist/eztock-print-agent
```

## Configuración

Variables de entorno:

| Variable | Descripción | Default |
|---|---|---|
| `AGENT_ID` | ID único del agente | (requerido) |
| `AGENT_ORGANIZATION_ID` | ID de la organización | (requerido) |
| `AGENT_BRANCH_ID` | ID de la sucursal | (requerido) |
| `AGENT_PAIRING_TOKEN` | Token de emparejamiento | (requerido) |
| `AGENT_BACKEND_URL` | URL del backend | `https://api.eztock.com` |
| `AGENT_WS_URL` | URL del WebSocket | `wss://api.eztock.com/ws/print-agent` |
| `AGENT_HTTP_PORT` | Puerto HTTP local | `9100` |
| `AGENT_DATA_DIR` | Directorio de datos | `~/.eztock-agent` |
| `AGENT_LOG_LEVEL` | Nivel de log | `info` |

## API Local

El agente expone una API HTTP en `http://127.0.0.1:9100`:

- `GET /health` - Health check
- `GET /status` - Estado del agente
- `GET /printers` - Impresoras descubiertas
- `GET /jobs` - Trabajos pendientes
- `GET /jobs/stats` - Estadísticas de la cola

## Soporte de Impresoras

| Tipo | Protocolo | Estado |
|---|---|---|
| Epson TM-T20/TM-T88 | ESC/POS (TCP 9100) | ✅ Soportado |
| Epson TM-T20/TM-T88 | ESC/POS (Serial/USB) | ✅ Soportado |
| Brother/Genéricas | PDF (CUPS/Spooler) | ✅ Soportado |
| Genéricas ESC/POS | RAW (CUPS `lp -o raw`) | ✅ Soportado |

## Cola Offline-First

- SQLite embebida (`bun:sqlite`) con WAL mode
- Jobs se encolan localmente cuando no hay conexión
- Reenvío automático al reconectar
- Cleanup diario: completados > 90 días, fallidos > 180 días

## Ciclo de Vida de un Job

```
pending → queued → printing → completed
                         ↓
                      failed ← (retry con backoff)
```

- Retry 1: inmediato
- Retry 2: 2 segundos
- Retry 3: 5 segundos
- Retry 4: 15 segundos

## Licencia

Propietario — Eztock
