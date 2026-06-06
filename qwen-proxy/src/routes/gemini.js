const express = require('express')
const router = express.Router()
const { validateApiKey } = require('../middlewares/authorization.js')
const { processRequestBody } = require('../middlewares/chat-middleware.js')
const { geminiToOpenAI, openaiToGeminiResponse, streamOpenAIToGemini } = require('../adapters/gemini.js')
const { sendChatRequest } = require('../utils/request.js')
const { accumulateResponse } = require('../utils/accumulate.js')
const { logger } = require('../utils/logger')
const config = require('../config/index.js')

/**
 * Gemini API key verification middleware
 * Accepts x-goog-api-key header, query param key, or Authorization: Bearer header
 */
const geminiKeyVerify = (req, res, next) => {
  if (config.apiKeys.length === 0) {
    req.isAdmin = true
    req.apiKey = ''
    return next()
  }

  const apiKey = req.headers['x-goog-api-key'] || req.query.key || req.headers['authorization'] || req.headers['Authorization']
  const { isValid, isAdmin } = validateApiKey(apiKey)

  if (!isValid) {
    return res.status(401).json({
      error: { code: 401, message: 'API key not valid. Please pass a valid API key.', status: 'UNAUTHENTICATED' }
    })
  }

  req.isAdmin = isAdmin
  req.apiKey = apiKey
  next()
}

/**
 * Extract model name from URL parameter (remove :generateContent or :streamGenerateContent suffix)
 */
function extractModelFromParam(modelParam) {
  if (!modelParam) return 'qwen3.6-plus'
  // The model param comes as "model-name" since Express handles the :method part via route
  return modelParam
}

/**
 * Handle Gemini generateContent (non-streaming)
 */
const handleGenerateContent = async (req, res) => {
  try {
    const geminiBody = req.body
    const urlModel = extractModelFromParam(req.params.model)

    // Convert Gemini request to OpenAI format
    const openaiBody = geminiToOpenAI(geminiBody, urlModel)
    openaiBody.stream = true // upstream always streams, we accumulate

    // Use the internal processRequestBody
    req.body = openaiBody
    await new Promise((resolve, reject) => {
      processRequestBody(req, res, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Send request to upstream
    const response_data = await sendChatRequest(req.body)

    if (!response_data.status || !response_data.response) {
      return res.status(500).json({
        error: { code: 500, message: 'Failed to send request to upstream', status: 'INTERNAL' }
      })
    }

    // Accumulate response
    const openaiResponse = await accumulateResponse(response_data.response, false, req.toolcall_enabled)
    const geminiResponse = openaiToGeminiResponse(openaiResponse)
    res.json(geminiResponse)
  } catch (error) {
    logger.error('Gemini generateContent error', 'GEMINI', '', error)
    res.status(500).json({
      error: { code: 500, message: error.message || 'Internal server error', status: 'INTERNAL' }
    })
  }
}

/**
 * Handle Gemini streamGenerateContent (streaming)
 */
const handleStreamGenerateContent = async (req, res) => {
  try {
    const geminiBody = req.body
    const urlModel = extractModelFromParam(req.params.model)

    // Convert Gemini request to OpenAI format
    const openaiBody = geminiToOpenAI(geminiBody, urlModel)
    openaiBody.stream = true

    // Use the internal processRequestBody
    req.body = openaiBody
    await new Promise((resolve, reject) => {
      processRequestBody(req, res, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Send request to upstream
    const response_data = await sendChatRequest(req.body)

    if (!response_data.status || !response_data.response) {
      return res.status(500).json({
        error: { code: 500, message: 'Failed to send request to upstream', status: 'INTERNAL' }
      })
    }

    // Stream response in Gemini format
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    streamOpenAIToGemini(res, response_data.response)
  } catch (error) {
    logger.error('Gemini streamGenerateContent error', 'GEMINI', '', error)
    res.status(500).json({
      error: { code: 500, message: error.message || 'Internal server error', status: 'INTERNAL' }
    })
  }
}

// Routes - Gemini v1beta
router.post('/v1beta/models/:model\\:generateContent', geminiKeyVerify, handleGenerateContent)
router.post('/v1beta/models/:model\\:streamGenerateContent', geminiKeyVerify, handleStreamGenerateContent)

// Routes - Gemini v1
router.post('/v1/models/:model\\:generateContent', geminiKeyVerify, handleGenerateContent)
router.post('/v1/models/:model\\:streamGenerateContent', geminiKeyVerify, handleStreamGenerateContent)

module.exports = router
