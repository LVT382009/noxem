const express = require('express')
const multer = require('multer')
const router = express.Router()
const { apiKeyVerify } = require('../middlewares/authorization.js')
const { uploadFileToQwenOss } = require('../utils/upload.js')
const { generateUUID } = require('../utils/tools.js')
const accountManager = require('../utils/account.js')
const { logger } = require('../utils/logger')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
})

// In-memory store: file_id → QwenFile object
const uploadedFiles = new Map()

function storeUploadedFile(qwenFile) {
  uploadedFiles.set(qwenFile.id, qwenFile)
}

function getUploadedFiles(fileIds) {
  const files = []
  for (const id of fileIds) {
    const f = uploadedFiles.get(id)
    if (f) files.push(f)
  }
  return files
}

/**
 * POST /v1/files/upload
 * Accepts multipart form data with a "file" field.
 * Returns: { id, object, name, size, file_class, qwen_file }
 */
const handleFileUpload = async (req, res) => {
  try {
    const file = req.file
    if (!file) {
      return res.status(400).json({
        error: { message: 'Missing "file" field in multipart form', type: 'invalid_request_error' }
      })
    }

    const authToken = accountManager.getAccountToken()
    if (!authToken) {
      return res.status(503).json({
        error: { message: 'No auth token available for upload', type: 'upload_error' }
      })
    }

    const filename = file.originalname || 'upload.txt'
    const fileBuffer = file.buffer
    const filesize = fileBuffer.length

    logger.info(`File upload: ${filename} (${filesize} bytes)`, 'FILES')

    const uploadResult = await uploadFileToQwenOss(fileBuffer, filename, authToken)

    if (!uploadResult || uploadResult.status !== 200 || !uploadResult.file_url) {
      return res.status(500).json({
        error: { message: 'Upload failed: ' + (uploadResult?.message || 'unknown error'), type: 'upload_error' }
      })
    }

    const fileId = uploadResult.file_id || generateUUID()
    const fileUrl = uploadResult.file_url
    const itemId = generateUUID()
    const taskId = generateUUID()

    const qwenFile = {
      type: 'file',
      file_class: 'document',
      file_type: file.mimetype || 'text/plain',
      showType: 'file',
      id: fileId,
      url: fileUrl,
      name: filename,
      size: filesize,
      status: 'uploaded',
      greenNet: 'success',
      progress: 0,
      error: '',
      itemId: itemId,
      uploadTaskId: taskId,
      collection_name: '',
      file: {
        id: fileId,
        filename: filename,
        user_id: '',
        created_at: Date.now(),
        update_at: Date.now(),
        data: {},
        hash: null,
        meta: {
          name: filename,
          size: filesize,
          content_type: file.mimetype || 'text/plain'
        }
      }
    }

    storeUploadedFile(qwenFile)
    logger.success(`File uploaded: id=${fileId} name=${filename} size=${filesize}`, 'FILES')

    return res.json({
      id: fileId,
      object: 'file',
      name: filename,
      size: filesize,
      file_class: 'document',
      qwen_file: qwenFile
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('File upload error', 'FILES', '', err)
    return res.status(500).json({ error: { message, type: 'upload_error' } })
  }
}

router.post('/v1/files/upload', apiKeyVerify, upload.single('file'), handleFileUpload)

module.exports = { router, getUploadedFiles, storeUploadedFile }
