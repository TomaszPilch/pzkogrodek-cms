import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function loadState(path, sourceUrl, targetUrl, contentType = 'api::event.event') {
  let state
  try {
    state = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { version: 1, sourceUrl, targetUrl, contentType, documents: {}, pending: null }
  }
  if (state?.version !== 1 || state.sourceUrl !== sourceUrl || state.targetUrl !== targetUrl ||
      (state.contentType ?? 'api::event.event') !== contentType ||
      !state.documents || typeof state.documents !== 'object' || Array.isArray(state.documents) ||
      Object.entries(state.documents).some(([id, value]) => !/^\d+$/.test(id) ||
        !value || typeof value.documentId !== 'string' || !value.documentId ||
        typeof value.locale !== 'string' || !value.locale)) {
    throw new Error('Invalid migration state or state belongs to different CMS URLs or content type')
  }
  if (state.pending) {
    throw new Error('An earlier event write has an uncertain outcome. Inspect the target, record its documentId in the state documents mapping if created, then clear pending before retrying. Do not delete the state file.')
  }
  return state
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flush: true })
  await rename(temporary, path)
}
