import { extractMemoriesLLM } from './memory-extract.mjs';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const EXTRACT_QUEUE_MAX = 200;
const EXTRACT_DEBOUNCE_MS = parseInt(process.env.EXTRACT_DEBOUNCE_MS || '2000');

const _extractionQueue = [];
let _extractLock = Promise.resolve();
let _extractTimer = null;

let _embedFn = null;
let _storeMemoryFn = null;
let _addVecsToIndexFn = null;
let _vectorKnnSearchFn = null;
let _invalidateQueryCacheFn = null;
let _isEmbeddingReadyFn = null;

export function initExtractionQueue({ embedFn, storeMemoryFn, addVecsToIndexFn, vectorKnnSearchFn, invalidateQueryCacheFn, isEmbeddingReadyFn }) {
  _embedFn = embedFn;
  _storeMemoryFn = storeMemoryFn;
  _addVecsToIndexFn = addVecsToIndexFn;
  _vectorKnnSearchFn = vectorKnnSearchFn;
  _invalidateQueryCacheFn = invalidateQueryCacheFn;
  _isEmbeddingReadyFn = isEmbeddingReadyFn;
}

export function enqueueExtraction(item) {
  if (_extractionQueue.length >= EXTRACT_QUEUE_MAX) {
    _extractionQueue.shift();
  }
  _extractionQueue.push(item);
  scheduleExtraction();
  return true;
}

function scheduleExtraction() {
  if (_extractTimer) clearTimeout(_extractTimer);
  _extractTimer = setTimeout(processExtractionQueue, EXTRACT_DEBOUNCE_MS);
}

async function processExtractionQueue() {
  _extractLock = _extractLock.then(async () => {
    while (_extractionQueue.length > 0) {
      const batch = _extractionQueue.splice(0, 5);
      for (const item of batch) {
        try {
          const llmMemories = await extractMemoriesLLM(item);
          for (const m of llmMemories) {
            if (_isEmbeddingReadyFn && _isEmbeddingReadyFn() && _embedFn) {
              try {
                const vec = new Float32Array(await _embedFn(m.text, 'document'));
                const existing = _vectorKnnSearchFn ? _vectorKnnSearchFn(vec, 3) : null;
                if (existing && existing.some(e => e.score > 0.92)) continue;

                const id = _storeMemoryFn({
                  session_id: item.session_id || '',
                  type: m.type,
                  text: m.text,
                  entity: m.entity || null,
                  attribute: m.attribute || null,
                  embedding: vec,
                  metadata: {
                    source: 'llm_extraction',
                    extraction_method: 'tier2_llm',
                    origin_session_id: item.session_id || '',
                    extracted_at: new Date().toISOString(),
                  },
                  importance: 0.5,
                });
                if (_addVecsToIndexFn && id) {
                  _addVecsToIndexFn([id], [Array.from(vec)]);
                }
              } catch (embedErr) {
                LOG_DEBUG && console.error('[ExtractQueue] Embed error:', embedErr.message);
              }
            }
          }
          if (_invalidateQueryCacheFn) _invalidateQueryCacheFn();
        } catch (err) {
          LOG_DEBUG && console.error('[ExtractQueue] Error:', err.message);
        }
      }
    }
  }).catch(err => {
    LOG_DEBUG && console.error('[ExtractQueue] Queue error:', err.message);
  });
}

export function getExtractionQueueStatus() {
  return {
    queue_length: _extractionQueue.length,
    max: EXTRACT_QUEUE_MAX,
    debounce_ms: EXTRACT_DEBOUNCE_MS,
  };
}
