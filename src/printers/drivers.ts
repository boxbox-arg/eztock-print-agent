import { $ } from 'bun';
import type { Logger } from '../logger.ts';

export async function printEscposTcp(
  host: string,
  port: number,
  content: Uint8Array,
  logger: Logger
): Promise<void> {
  logger.debug(`Sending ESC/POS to ${host}:${port}`);

  const socket = await Bun.connect({
    hostname: host,
    port,
  });

  try {
    const writer = socket.writer();
    writer.write(content);
    writer.end();

    // Wait briefly for data to flush
    await new Promise(resolve => setTimeout(resolve, 500));

    logger.debug('ESC/POS data sent successfully');
  } finally {
    socket.end();
  }
}

export async function printEscposSerial(
  portPath: string,
  content: Uint8Array,
  logger: Logger
): Promise<void> {
  logger.debug(`Sending ESC/POS to serial port ${portPath}`);

  try {
    // Try using stty + echo for Linux
    const result = await $`stty -F ${portPath} 9600 cs8 -cstopb -parenb && echo -n ${Buffer.from(content)} > ${portPath}`.nothrow().quiet();

    if (result.exitCode !== 0) {
      throw new Error(`Serial write failed: ${result.stderr.toString()}`);
    }

    logger.debug('ESC/POS serial data sent successfully');
  } catch (err) {
    logger.error('Serial print failed:', err);
    throw err;
  }
}

export async function printPdf(
  systemName: string,
  content: Uint8Array,
  logger: Logger
): Promise<void> {
  logger.debug(`Printing PDF to ${systemName}`);

  const tempFile = `/tmp/eztock-print-${Date.now()}.pdf`;
  await Bun.write(tempFile, content);

  try {
    const os = process.platform;

    if (os === 'linux' || os === 'darwin') {
      const result = await $`lp -d ${systemName} ${tempFile}`.nothrow().quiet();
      if (result.exitCode !== 0) {
        throw new Error(`PDF print failed: ${result.stderr.toString()}`);
      }
    } else if (os === 'win32') {
      const result = await $`powershell -Command "Start-Process -FilePath '${tempFile}' -Verb print -PassThru | Wait-Process"`.nothrow().quiet();
      if (result.exitCode !== 0) {
        throw new Error(`PDF print failed on Windows: ${result.stderr.toString()}`);
      }
    } else {
      throw new Error(`PDF printing not supported on platform: ${os}`);
    }

    logger.debug('PDF printed successfully');
  } finally {
    await $`rm -f ${tempFile}`.nothrow().quiet();
  }
}
