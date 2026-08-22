/**
 * Algorand x402 Middleware — GoPlausible Facilitator
 *
 * Replaces the previous hand-rolled implementation with the official
 * @x402/express + @x402/avm stack, delegating payment verification and
 * settlement to GoPlausible's hosted facilitator.
 *
 * Flow (handled entirely by the middleware + facilitator):
 *   1. First request (no X-PAYMENT) → middleware returns HTTP 402 with
 *      Algorand payment requirements (amount, recipient, network)
 *   2. Client builds, signs, and submits the Algorand tx via @x402/avm
 *   3. Client retries with X-PAYMENT header containing the signed tx payload
 *   4. Middleware forwards to GoPlausible facilitator → /verify then /settle
 *   5. On success → next() is called → controller takes over
 *
 * The server never touches private keys or submits transactions.
 * GoPlausible's facilitator handles on-chain confirmation and fee abstraction.
 */

import {
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_HASH,
} from '@x402/avm'
import { ExactAvmScheme } from '@x402/avm/exact/server'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import type { Network } from '@x402/core/types'
import { paymentMiddleware } from '@x402/express'
import { getAmountInUSD } from '../utils/constant.js'
import { logger } from '../utils/logger.js'
import { getPricingConfig } from '../utils/pricing.js'

const isMainnet = process.env.ALGO_NETWORK === 'mainnet'
const ALGO_NETWORK = (
  isMainnet
    ? `algorand:${ALGORAND_MAINNET_GENESIS_HASH}`
    : `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`
) as Network

/** Server's Algorand receiving address */
const ALGO_RECIPIENT = process.env.ALGO_WALLET_ADDRESS

/**
 * GoPlausible hosted facilitator — handles verify + settle for Algorand.
 * Override with ALGO_FACILITATOR_URL env var to use a self-hosted facilitator.
 */
const FACILITATOR_URL =
  process.env.ALGO_FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz'

let algoX402Middleware: ReturnType<typeof paymentMiddleware> | null = null

if (!ALGO_RECIPIENT) {
  logger.warn(
    'ALGO_WALLET_ADDRESS is not set — POST /upload/algo-agent will not require payment',
  )
} else {
  try {
    const facilitatorClient = new HTTPFacilitatorClient({
      url: FACILITATOR_URL,
    })

    // Register the AVM exact scheme on the resource server
    const server = new x402ResourceServer(facilitatorClient).register(
      ALGO_NETWORK,
      new ExactAvmScheme(),
    )

    algoX402Middleware = paymentMiddleware(
      {
        'POST /algo-agent': {
          accepts: {
            scheme: 'exact',
            network: ALGO_NETWORK,
            payTo: ALGO_RECIPIENT,
            /**
             * Dynamic pricing: reads ?size and ?duration from query params,
             * computes cost in USD from the DB config rate, returns as "$X.XXXXXX".
             */
            price: async (context) => {
              const sizeParam = context.adapter.getQueryParam?.('size')
              const durationParam = context.adapter.getQueryParam?.('duration')
              const size = parseInt(
                (Array.isArray(sizeParam) ? sizeParam[0] : sizeParam) || '0',
                10,
              )
              const duration = parseInt(
                (Array.isArray(durationParam)
                  ? durationParam[0]
                  : durationParam) || '1',
                10,
              )
              const { ratePerBytePerDay } = await getPricingConfig()
              const costUSD = getAmountInUSD(size, ratePerBytePerDay, duration)
              // floor at $0.000001 to avoid zero-price edge cases on tiny files
              return `$${Math.max(costUSD, 0.000001).toFixed(6)}`
            },
          },
          description: 'Algorand x402 IPFS storage upload',
        },
      },
      server,
    )

    logger.info(
      'Algorand x402 middleware initialised (GoPlausible facilitator)',
      {
        network: ALGO_NETWORK,
        facilitator: FACILITATOR_URL,
        payTo: ALGO_RECIPIENT,
      },
    )
  } catch (err) {
    logger.error('Failed to initialise Algorand x402 middleware', {
      error: err,
    })
  }
}

export { algoX402Middleware }
