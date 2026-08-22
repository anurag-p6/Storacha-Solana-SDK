import { wrapFetchWithPayment } from '@x402/fetch'
import {
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_HASH,
  toClientAvmSigner,
} from '@x402/avm'
import { ExactAvmScheme } from '@x402/avm/exact/client'
import { x402Client } from '@x402/core/client'
import type { Network } from '@x402/core/types'
import algosdk from 'algosdk'
import {
  ALGOD_SERVERS,
  ALGOD_TOKEN_DEFAULT,
  ENDPOINTS,
  PRICING_ROUTE,
  UPLOAD_ROUTE,
} from './constants'
import type {
  AlgoAgentClientOptions,
  Environment,
  StorageCostEstimate,
  StoreOptions,
  StoreResult,
} from './types'

/** Cross-platform Uint8Array → base64 (works in Node.js and browsers) */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

export class AlgoAgentClient {
  private readonly apiEndpoint: string
  private readonly environment: Environment
  private readonly signer: ReturnType<typeof toClientAvmSigner>
  private readonly x402: x402Client
  private readonly network: Network

  constructor({
    mnemonic,
    environment,
    endpoint,
    algodServer,
    algodToken,
  }: AlgoAgentClientOptions) {
    this.environment = environment
    this.apiEndpoint = endpoint ?? ENDPOINTS[environment]
    this.network = `algorand:${
      environment === 'mainnet'
        ? ALGORAND_MAINNET_GENESIS_HASH
        : ALGORAND_TESTNET_GENESIS_HASH
    }` as Network

    // Convert 25-word mnemonic → 64-byte Ed25519 secret key → base64 for @x402/avm
    const account = algosdk.mnemonicToSecretKey(mnemonic)
    const base64Key = uint8ArrayToBase64(account.sk)

    // Build the AVM signer (takes base64 private key only)
    this.signer = toClientAvmSigner(base64Key)

    // Build the ExactAvmScheme — native ALGO payments (asset 0)
    // spend controls disabled since ALGO is not a default USDC asset
    const avmScheme = new ExactAvmScheme(this.signer, {
      algodUrl: algodServer ?? ALGOD_SERVERS[environment],
      algodToken: (algodToken ?? ALGOD_TOKEN_DEFAULT) || undefined,
    })

    // Build the x402 client and register the AVM scheme
    this.x402 = new x402Client()
    this.x402.register(this.network, avmScheme)
    this.x402.setSpendControls(false)
  }

  /**
   * The Algorand address derived from the provided mnemonic.
   */
  get address(): string {
    return this.signer.address
  }

  /**
   * Store a file on IPFS. Payment in ALGO is handled automatically
   * via the x402 protocol with GoPlausible's facilitator.
   *
   * Flow (handled by @x402/fetch + @x402/avm):
   *   1. POST to /upload/algo-agent → server returns 402 with payment requirements
   *   2. @x402/avm builds and signs the Algorand payment transaction group
   *   3. GoPlausible facilitator verifies and settles on-chain (~3s)
   *   4. @x402/fetch retries with X-PAYMENT header containing the signed payload
   *   5. Server pins file to IPFS and returns the result
   *
   * @example
   * const { cid, expiresAt, paymentTxId } = await client.store(file, { durationDays: 30 })
   */
  async store(
    file: File,
    { durationDays }: StoreOptions,
  ): Promise<StoreResult> {
    const url = `${this.apiEndpoint}${UPLOAD_ROUTE}?size=${file.size}&duration=${durationDays}`

    const form = new FormData()
    form.append('file', file)

    const response = await wrapFetchWithPayment(fetch, this.x402)(url, {
      method: 'POST',
      body: form,
    })

    if (!response.ok) {
      const errBody = (await response.json().catch(() => ({}))) as {
        message?: string
        error?: string
      }
      throw new Error(
        errBody.message ??
          errBody.error ??
          `Upload failed with status ${response.status}`,
      )
    }

    return response.json() as Promise<StoreResult>
  }

  /**
   * Estimate the ALGO cost for storing a file before committing to an upload.
   *
   * @example
   * const { algo, usd, microAlgo } = await client.estimateStorageCost(1_000_000, 30)
   * console.log(`Cost: ${algo} ALGO (~$${usd})`)
   */
  async estimateStorageCost(
    sizeInBytes: number,
    durationDays: number,
  ): Promise<StorageCostEstimate> {
    const res = await fetch(
      `${this.apiEndpoint}${PRICING_ROUTE}?size=${sizeInBytes}&duration=${durationDays}&chain=algo`,
    )

    if (!res.ok)
      throw new Error('Failed to fetch storage cost estimate from toju API')

    const { quote } = (await res.json()) as {
      quote: { totalCost: number; algoPrice?: number }
    }
    const totalUsd: number = quote.totalCost
    const algoUsdPrice: number = quote.algoPrice ?? 0.15
    const totalAlgo = totalUsd / algoUsdPrice
    const microAlgo = Math.ceil(totalAlgo * 1_000_000)

    return {
      algo: totalAlgo.toFixed(6),
      usd: totalUsd.toFixed(2),
      microAlgo,
    }
  }
}

/** Convenience factory */
export function createAlgoAgentClient(
  options: AlgoAgentClientOptions,
): AlgoAgentClient {
  return new AlgoAgentClient(options)
}

export type { Environment }
