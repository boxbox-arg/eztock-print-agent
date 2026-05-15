import { hostname, platform } from 'os'

export interface PairingResult {
  agentId: string
  organizationId: string
  branchId: string
  pairingToken: string
}

export class PairingClient {
  private backendUrl: string

  constructor(backendUrl: string) {
    this.backendUrl = backendUrl.replace(/\/+$/, '')
  }

  async claimPairing(pairingCode: string): Promise<PairingResult> {
    const url = `${this.backendUrl}/api/v1/printing/agents/claim-pairing`
    const os = platform()
    const osName = os === 'win32' ? 'windows' : os === 'darwin' ? 'macos' : 'linux'

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: pairingCode.toUpperCase(),
        hostname: hostname(),
        os: osName,
        version: '0.1.0',
      }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }))
      throw new Error(error.message || `Error de emparejamiento (HTTP ${response.status})`)
    }

    const result = await response.json()
    const data = result.data

    return {
      agentId: data.agentId,
      organizationId: data.organizationId,
      branchId: data.branchId,
      pairingToken: data.pairingToken,
    }
  }
}
