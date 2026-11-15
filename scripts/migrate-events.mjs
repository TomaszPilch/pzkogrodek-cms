import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { contentUrl, toBlocks } from './event-blocks.mjs'
import { loadState, saveState } from './event-migration-state.mjs'

const PAGE_SIZE = 100
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const localizedFields = ['name', 'description', 'content']
const sharedFields = ['start', 'end', 'inBuilding', 'image']

function baseUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CMS URLs must be HTTP(S) URLs without credentials, query strings or fragments')
  }
  return url.href.replace(/\/$/, '')
}

export function apiClient(base, token, fetchImpl = fetch) {
  return async (path, params = {}, { method = 'GET', data, form } = {}) => {
    const url = new URL(`${base}${path}`)
    url.search = new URLSearchParams(params).toString()
    const headers = { Authorization: `Bearer ${token}` }
    if (data) headers['Content-Type'] = 'application/json'
    const response = await fetchImpl(url, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(60000),
      body: form ?? (data ? JSON.stringify({ data }) : undefined),
    })
    // Do not echo server responses or request headers, which can contain credentials.
    if (!response.ok) throw new Error(`${method} ${path} failed (HTTP ${response.status})`)
    return response.json()
  }
}

async function collection(api, params, endpoint = '/api/events') {
  const entries = []
  for (let page = 1; ; page += 1) {
    const response = await api(endpoint, {
      ...params, 'pagination[page]': page, 'pagination[pageSize]': PAGE_SIZE, sort: 'id:asc',
    })
    const pagination = response.meta?.pagination
    if (!Array.isArray(response.data) || !Number.isInteger(pagination?.pageCount)) {
      throw new Error('Invalid event response or missing pagination metadata')
    }
    entries.push(...response.data)
    if (page >= pagination.pageCount) return entries
    if (!response.data.length) throw new Error('Empty page before the end of event pagination')
  }
}

export function mediaFromV4(value) {
  if (!value || !Object.hasOwn(value, 'data')) throw new Error('Missing populated event image; check v4 media permissions')
  if (value.data === null) return null
  if (!value.data.attributes?.url) throw new Error('Invalid populated event image')
  return value.data.attributes
}

export function prepareEvents(rows, sourceUrl) {
  const seen = new Set()
  return rows.map(({ id, attributes: event }) => {
    if (!id || !event?.publishedAt) throw new Error('Source returned a draft or an invalid v4 event')
    if (!event.locale || !event.name?.trim()) {
      throw new Error(`Event ${id} needs a locale and name`)
    }
    if (seen.has(id)) throw new Error(`Duplicate source ID at event ${id}`)
    seen.add(id)
    for (const field of ['description', 'content']) {
      if (!Object.hasOwn(event, field)) throw new Error(`Source event ${id} is missing ${field}; check its schema and read permissions`)
    }
    if (!Array.isArray(event.localizations?.data)) throw new Error(`Missing populated localizations at event ${id}`)
    const end = event.end === '' ? null : event.end ?? null
    const inBuilding = event.inBuilding ?? true
    if (!event.start || !Number.isFinite(Date.parse(event.start)) ||
        (end !== null && !Number.isFinite(Date.parse(end))) || typeof inBuilding !== 'boolean') {
      throw new Error(`Invalid dates or inBuilding at event ${id}`)
    }
    try {
      return {
        id, locale: event.locale, slug: event.slug,
        relatedIds: event.localizations.data.map((entry) => entry.id),
        data: {
          name: event.name, description: event.description ?? null,
          content: toBlocks(event.content, sourceUrl),
          start: event.start, end, inBuilding,
          image: mediaFromV4(event.image),
        },
      }
    } catch (error) {
      throw new Error(`Event ${id} (${event.locale}): ${error.message}`)
    }
  })
}

export function groupEvents(events, fields = sharedFields) {
  const parents = new Map()
  const root = (id) => {
    if (!parents.has(id)) parents.set(id, id)
    if (parents.get(id) !== id) parents.set(id, root(parents.get(id)))
    return parents.get(id)
  }
  for (const event of events) {
    for (const id of event.relatedIds) parents.set(root(id), root(event.id))
  }
  const groups = new Map()
  for (const event of events) {
    const id = root(event.id)
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(event)
  }
  for (const group of groups.values()) {
    if (new Set(group.map((event) => event.locale)).size !== group.length) {
      throw new Error('A source localization group contains duplicate locales')
    }
    for (const event of group.slice(1)) {
      for (const field of fields) {
        const value = (entry) => field === 'image' ? entry.data.image?.url ?? null : entry.data[field]
        if (value(event) !== value(group[0])) {
          throw new Error(`Source translations disagree on non-localized ${field} (event ${event.id})`)
        }
      }
    }
  }
  return [...groups.values()]
}

export function planMigration(groups, targets, mappings = {}) {
  const claimed = new Set()
  return groups.map((events) => {
    const matches = events.map((event) => {
      const mapped = mappings[event.id]
      if (mapped) {
        if (mapped.locale !== event.locale || !targets.some((entry) =>
          entry.documentId === mapped.documentId && entry.locale === event.locale)) {
          throw new Error(`Saved target for source event ${event.id} is missing or its locale changed`)
        }
        return mapped.documentId
      }
      if (!event.slug) return undefined
      const documents = new Set(targets.filter((entry) =>
        entry.locale === event.locale && entry.slug === event.slug).map((entry) => entry.documentId))
      if (documents.size > 1) throw new Error(`Ambiguous target slug/locale for event ${event.id}`)
      return [...documents][0]
    })
    const documents = new Set(matches.filter(Boolean))
    if (documents.size > 1) throw new Error('Source translations match separate v5 documents; merge them manually first')
    const documentId = [...documents][0]
    if (documentId && claimed.has(documentId)) throw new Error('Unrelated source groups match the same v5 document')
    if (documentId) claimed.add(documentId)
    for (const event of events) {
      const occupied = targets.filter((entry) => entry.documentId === documentId && entry.locale === event.locale)
      if (!mappings[event.id] && occupied.some((entry) => entry.slug !== event.slug)) {
        throw new Error(`Target document has a conflicting slug or draft for event ${event.id}`)
      }
    }
    return { events, documentId }
  })
}

function imageUrl(value, sourceUrl, allowedOrigins) {
  const url = new URL(contentUrl(value, `${sourceUrl}/`, true))
  url.hash = ''
  if (!allowedOrigins.has(url.origin)) {
    throw new Error(`Media origin ${url.origin} is not allowed; review it and add it to STRAPI_MEDIA_ORIGINS`)
  }
  return url.href
}

async function imageBytes(url, fetchImpl) {
  // Media requests never carry either API token, including to the old CMS.
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`Image download failed (HTTP ${response.status})`)
  const mime = response.headers.get('content-type')?.split(';')[0]
  if (!mime?.startsWith('image/')) {
    await response.body?.cancel()
    throw new Error('Media URL did not return an image')
  }
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel()
    throw new Error('Image exceeds the 20 MiB migration limit')
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > MAX_IMAGE_BYTES) {
      await reader.cancel()
      throw new Error('Image exceeds the 20 MiB migration limit')
    }
    chunks.push(value)
  }
  if (!length) throw new Error('Empty image response')
  return new Blob(chunks, { type: mime })
}

export function mediaTransfer(target, sourceUrl, targetUrl, allowedOrigins, fetchImpl = fetch) {
  const cache = new Map()
  return async (source) => {
    const url = imageUrl(source.url, sourceUrl, allowedOrigins)
    if (cache.has(url)) return cache.get(url)
    const blob = await imageBytes(url, fetchImpl)
    const name = source.name || decodeURIComponent(new URL(url).pathname.split('/').at(-1)) || 'image'
    const existing = await target('/api/upload/files', { 'filters[name][$eq]': name })
    if (!Array.isArray(existing) || existing.length > 1) throw new Error('Ambiguous or invalid target media lookup')
    let file = existing[0]
    if (!file) {
      const form = new FormData()
      form.append('files', blob, name)
      form.append('fileInfo', JSON.stringify({
        name, alternativeText: source.alternativeText ?? null, caption: source.caption ?? null,
      }))
      const uploaded = await target('/api/upload', {}, { method: 'POST', form })
      if (!Array.isArray(uploaded) || uploaded.length !== 1) throw new Error('Invalid media upload response')
      file = uploaded[0]
    }
    for (const key of ['id', 'name', 'url', 'width', 'height', 'hash', 'ext', 'mime', 'size', 'provider', 'createdAt', 'updatedAt']) {
      if (file[key] == null) throw new Error(`Target image is missing ${key}`)
    }
    const result = { ...file, url: contentUrl(file.url, `${targetUrl}/`, true) }
    cache.set(url, result)
    return result
  }
}

export async function transferBlocks(blocks, transfer) {
  const content = []
  for (const block of blocks) {
    if (block.type !== 'image') {
      content.push(block)
      continue
    }
    const file = await transfer(block.image)
    const { id, documentId, ...image } = file
    void id
    void documentId
    content.push({
      ...block,
      image: { ...image, alternativeText: block.image.alternativeText, caption: block.image.caption },
    })
  }
  return content
}

async function migratedData(event, transfer) {
  return {
    ...event.data,
    image: event.data.image ? (await transfer(event.data.image)).id : null,
    content: await transferBlocks(event.data.content, transfer),
  }
}

function verifyEvent(actual, expected, locale, documentId, profile) {
  if (!actual?.documentId || (documentId && actual.documentId !== documentId) ||
      actual.locale !== locale || !actual.publishedAt) {
    throw new Error('Target event was not published in the expected document and locale')
  }
  for (const field of [...profile.localizedFields, ...profile.sharedFields]) {
    if (field === 'image') continue
    const value = profile.normalize(field, actual[field])
    const wanted = profile.normalize(field, expected[field])
    const equal = ['start', 'end'].includes(field) && value && expected[field]
      ? Date.parse(value) === Date.parse(expected[field])
      : isDeepStrictEqual(value, wanted)
    if (!equal) throw new Error(`Target did not preserve ${field}`)
  }
}

const eventProfile = {
  contentType: 'api::event.event',
  endpoint: '/api/events',
  localizedFields,
  sharedFields,
  populateSource: { 'populate[0]': 'image', 'populate[1]': 'localizations' },
  populateTarget: { populate: 'image' },
  prepare: prepareEvents,
  images: (event) => [
    event.data.image, ...event.data.content.filter((block) => block.type === 'image').map((block) => block.image),
  ],
  transfer: migratedData,
  normalize: (field, value) => value,
  createData: (data) => data,
}

export async function migrate({
  sourceUrl, targetUrl, sourceToken, targetToken, apply = false,
  mediaOrigins = [], fetchImpl = fetch, log = console.log,
  statePath = '.migration-state/events.json',
  profile = eventProfile,
}) {
  sourceUrl = baseUrl(sourceUrl)
  targetUrl = baseUrl(targetUrl)
  if (sourceUrl === targetUrl) throw new Error('Source and target must be different CMS instances')
  if (!sourceToken || !targetToken) throw new Error('Set STRAPI_V4_API_TOKEN and STRAPI_V5_API_TOKEN')
  const state = await loadState(statePath, sourceUrl, targetUrl, profile.contentType)
  const allowedOrigins = new Set([new URL(sourceUrl).origin, ...mediaOrigins.map((url) => new URL(baseUrl(url)).origin)])
  const source = apiClient(sourceUrl, sourceToken, fetchImpl)
  const target = apiClient(targetUrl, targetToken, fetchImpl)
  const events = await profile.prepare(await collection(source, {
    locale: 'all', publicationState: 'live', ...profile.populateSource,
  }, profile.endpoint), `${sourceUrl}/`, { sourceUrl, targetUrl, source, target })
  const targets = []
  for (const locale of new Set(events.map((event) => event.locale))) {
    for (const status of ['published', 'draft']) {
      const entries = await collection(target, { locale, status }, profile.endpoint)
      if (entries.some((entry) => !entry.documentId || entry.locale !== locale)) {
        throw new Error('Expected v5 flat event responses in the requested locale')
      }
      targets.push(...entries)
    }
  }
  const plan = planMigration(groupEvents(events, profile.sharedFields), targets, state.documents)
  const images = new Set()
  for (const event of events) {
    for (const image of profile.images(event)) {
      if (image) images.add(imageUrl(image.url, sourceUrl, allowedOrigins))
    }
  }
  log(`${apply ? 'APPLY' : 'DRY RUN'} (${profile.contentType}): ${events.length} published translations, ${plan.length} documents, ${images.size} image URLs.`)
  for (const item of plan) {
    log(`${item.documentId ? 'Update' : 'Create'} document: source IDs ${item.events.map((event) => `${event.id}:${event.locale}`).join(', ')}`)
  }
  if (!apply) {
    log('No writes made. Review the plan, back up v5, then rerun with --apply.')
    return
  }
  await saveState(statePath, state)
  const transfer = mediaTransfer(target, sourceUrl, targetUrl, allowedOrigins, fetchImpl)
  // Finish conversion and media transfer before writing any event.
  const prepared = new Map()
  for (const event of events) prepared.set(event.id, await profile.transfer(event, transfer))
  for (const item of plan) {
    let documentId = item.documentId
    // Start with an existing locale so shared fields are updated before creating translations.
    const ordered = [...item.events].sort((a, b) =>
      Number(targets.some((entry) => entry.documentId === documentId && entry.locale === b.locale)) -
      Number(targets.some((entry) => entry.documentId === documentId && entry.locale === a.locale)))
    for (const event of ordered) {
      const data = prepared.get(event.id)
      const newLocale = documentId && !targets.some((entry) => entry.documentId === documentId && entry.locale === event.locale)
      let payload = newLocale ? Object.fromEntries(profile.localizedFields.map((field) => [field, data[field]])) : data
      if (!documentId || newLocale) payload = profile.createData(payload, event)
      state.pending = { sourceId: event.id, locale: event.locale, documentId: documentId ?? null }
      await saveState(statePath, state)
      const response = await target(documentId ? `${profile.endpoint}/${encodeURIComponent(documentId)}` : profile.endpoint, {
        locale: event.locale, status: 'published', ...profile.populateTarget,
      }, { method: documentId ? 'PUT' : 'POST', data: payload })
      if (!response.data?.documentId || response.data.locale !== event.locale ||
          (documentId && response.data.documentId !== documentId)) {
        throw new Error('Unexpected target identity; inspect the pending migration state before retrying')
      }
      documentId = response.data.documentId
      state.documents[event.id] = { documentId, locale: event.locale }
      state.pending = null
      await saveState(statePath, state)
      verifyEvent(response.data, data, event.locale, documentId, profile)
      targets.push({ documentId, locale: event.locale, slug: response.data.slug })
      log(`Migrated ${profile.contentType} source ${event.id} (${event.locale})`)
    }
    // Re-read every locale after shared-field synchronization and publishing.
    for (const event of item.events) {
      const response = await target(`${profile.endpoint}/${encodeURIComponent(documentId)}`, {
        locale: event.locale, status: 'published', ...profile.populateTarget,
      })
      verifyEvent(response.data, prepared.get(event.id), event.locale, documentId, profile)
    }
  }
  log(`Migration complete (${profile.contentType}). Published fields verified, excluding slugs and media relations.`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: yarn migrate:events [--apply]\nDefault: read-only preview. Set STRAPI_V4_API_TOKEN and STRAPI_V5_API_TOKEN.\nOptional: STRAPI_V4_URL, STRAPI_V5_URL, STRAPI_MEDIA_ORIGINS, STRAPI_MIGRATION_STATE.\nKeep the migration state file for safe reruns with generated slugs. See README.md.')
    return
  }
  if (args.some((arg) => arg !== '--apply')) throw new Error('Unknown argument. Use --help.')
  await migrate({
    sourceUrl: process.env.STRAPI_V4_URL || 'https://cms.pzkogrodek.cz',
    targetUrl: process.env.STRAPI_V5_URL || 'https://cms-new.pzkogrodek.cz',
    sourceToken: process.env.STRAPI_V4_API_TOKEN,
    targetToken: process.env.STRAPI_V5_API_TOKEN,
    mediaOrigins: (process.env.STRAPI_MEDIA_ORIGINS || '').split(',').filter(Boolean),
    apply: args.includes('--apply'),
    statePath: process.env.STRAPI_MIGRATION_STATE || '.migration-state/events.json',
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Migration stopped: ${error.message}`)
    process.exitCode = 1
  })
}
