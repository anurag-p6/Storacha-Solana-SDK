import express from 'express'
import multer from 'multer'
import * as agentController from '../controllers/agent.controller.js'
import * as algoAgentController from '../controllers/algo-agent.controller.js'
import * as uploadsController from '../controllers/upload.controller.js'
import { algoX402Middleware } from '../middlewares/algo-x402.middleware.js'
import { uploadLimiter } from '../middlewares/rate-limit.middleware.js'
import { agentPaymentMiddleware } from '../middlewares/x402.middleware.js'

const upload = multer()

export const uploadsRouter = express.Router()

// EVM x402 payment gate — applies only to POST /agent
if (agentPaymentMiddleware) uploadsRouter.use(agentPaymentMiddleware)

// Algorand x402 payment gate (GoPlausible facilitator) — applies only to POST /algo-agent
if (algoX402Middleware) uploadsRouter.use(algoX402Middleware)

uploadsRouter.post(
  '/deposit',
  upload.fields([{ name: 'file' }]),
  uploadsController.deposit,
)
uploadsRouter.post(
  '/deposit-usdfc',
  upload.fields([{ name: 'file' }]),
  uploadsController.depositUsdFC,
)
uploadsRouter.post(
  '/file',
  uploadLimiter,
  upload.single('file'),
  uploadsController.uploadFile,
)
uploadsRouter.post(
  '/files',
  uploadLimiter,
  upload.array('file'),
  uploadsController.uploadFiles,
)
uploadsRouter.get('/history', uploadsController.getUploadHistory)
uploadsRouter.post('/confirm', uploadsController.confirmUpload)
uploadsRouter.post('/fil/verify-payment', uploadsController.verifyUsdFcPayment)

uploadsRouter.post(
  '/agent',
  upload.single('file'),
  agentController.uploadAgentFile,
)

uploadsRouter.post(
  '/algo-agent',
  upload.single('file'),
  algoAgentController.uploadAlgoAgentFile,
)
