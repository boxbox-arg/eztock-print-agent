import { platform } from 'os';
import { $ } from 'bun';
import type { PrinterInfo, Logger } from '../types.ts';

export async function discoverPrinters(logger: Logger): Promise<PrinterInfo[]> {
  const os = platform();
  logger.info('Discovering printers on platform:', os);

  switch (os) {
    case 'win32':
      return discoverWindows(logger);
    case 'linux':
      return discoverLinux(logger);
    case 'darwin':
      return discoverMacOS(logger);
    default:
      logger.warn('Unsupported platform for printer discovery:', os);
      return [];
  }
}

async function discoverLinux(logger: Logger): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    const result = await $`lpstat -v`.nothrow().quiet();
    if (result.exitCode !== 0) {
      logger.warn('lpstat failed:', result.stderr.toString());
      return printers;
    }

    const lines = result.stdout.toString().split('\n');
    for (const line of lines) {
      const match = line.match(/device for\s+(\S+):\s+(.+)/);
      if (!match) continue;

      const systemName = match[1];
      const deviceUri = match[2].trim();

      let connectionType: PrinterInfo['connectionType'] = 'usb';
      if (deviceUri.startsWith('socket://') || deviceUri.startsWith('ipp://')) {
        connectionType = 'network';
      } else if (deviceUri.startsWith('bluetooth://')) {
        connectionType = 'bluetooth';
      }

      const infoResult = await $`lpstat -p ${systemName}`.nothrow().quiet();
      const infoLines = infoResult.stdout.toString().split('\n');
      const descriptionLine = infoLines.find(l => l.includes('Description:'));
      const name = descriptionLine?.split('Description:')[1]?.trim() ?? systemName;

      let host: string | undefined;
      let port: number | undefined;
      if (deviceUri.startsWith('socket://')) {
        const url = new URL(deviceUri.replace('socket://', 'http://'));
        host = url.hostname;
        port = url.port ? parseInt(url.port, 10) : 9100;
      }

      printers.push({
        id: `linux-${systemName}`,
        name,
        systemName,
        driver: inferDriver(name, deviceUri),
        connectionType,
        connectionConfig: { deviceUri, host, port },
        capabilities: defaultCapabilities(),
        status: infoLines.some(l => l.includes('idle')) ? 'online' : 'offline',
        isDefault: false,
      });
    }
  } catch (err) {
    logger.error('Error discovering Linux printers:', err);
  }

  logger.info(`Found ${printers.length} printers on Linux`);
  return printers;
}

async function discoverWindows(logger: Logger): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    const script = `
      Get-Printer | ForEach-Object {
        $name = $_.Name
        $driver = $_.DriverName
        $port = $_.PortName
        $status = $_.Status
        $default = if ($_.Default) { "true" } else { "false" }
        Write-Output "$name|$driver|$port|$status|$default"
      }
    `;

    const result = await $`powershell -Command ${script}`.nothrow().quiet();
    if (result.exitCode !== 0) {
      logger.warn('PowerShell printer discovery failed:', result.stderr.toString());
      return printers;
    }

    const lines = result.stdout.toString().split('\n');
    for (const line of lines) {
      const parts = line.trim().split('|');
      if (parts.length < 5) continue;

      const [name, driverName, portName, status, isDefaultStr] = parts;
      const isDefault = isDefaultStr === 'true';

      let connectionType: PrinterInfo['connectionType'] = 'usb';
      if (portName?.includes('TCP') || portName?.includes('IP_')) {
        connectionType = 'network';
      }

      printers.push({
        id: `win-${name}`,
        name,
        systemName: name,
        driver: inferDriver(name, driverName),
        connectionType,
        connectionConfig: { serialPort: portName },
        capabilities: defaultCapabilities(),
        status: status?.toLowerCase().includes('error') ? 'error' : 'online',
        isDefault,
      });
    }
  } catch (err) {
    logger.error('Error discovering Windows printers:', err);
  }

  logger.info(`Found ${printers.length} printers on Windows`);
  return printers;
}

async function discoverMacOS(logger: Logger): Promise<PrinterInfo[]> {
  // macOS uses CUPS same as Linux
  return discoverLinux(logger);
}

function inferDriver(name: string, uriOrDriver: string): PrinterInfo['driver'] {
  const lower = `${name} ${uriOrDriver}`.toLowerCase();
  if (lower.includes('epson') || lower.includes('thermal') || lower.includes('tm-t') || lower.includes('escpos') || lower.includes('pos')) {
    return 'escpos';
  }
  if (lower.includes('pdf') || lower.includes('brother') || lower.includes('laser') || lower.includes('hp')) {
    return 'pdf';
  }
  return 'raw';
}

function defaultCapabilities() {
  return {
    escpos: {
      qr: true,
      barcode: true,
      image: true,
      cutter: true,
      cashDrawer: true,
      utf8: false,
      codepage: 858,
      density: [0, 1, 2, 3],
      paperWidths: [80],
    },
    pdf: {
      color: false,
      duplex: false,
      maxDpi: 300,
      paperSizes: ['A4', 'letter'],
    },
    supportedFormats: ['escpos', 'pdf', 'raw'],
  };
}
