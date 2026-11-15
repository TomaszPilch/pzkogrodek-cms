import { readdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import slugify from 'slugify'
import { apiClient } from './migrate-events.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export async function slugCollections() {
  const collections = []
  const apiDirectory = join(root, 'src', 'api')
  for (const api of await readdir(apiDirectory, { withFileTypes: true })) {
    if (!api.isDirectory()) continue
    const typesDirectory = join(apiDirectory, api.name, 'content-types')
    let types
    try {
      types = await readdir(typesDirectory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const type of types) {
      if (!type.isDirectory()) continue
      const schema = JSON.parse(await readFile(join(typesDirectory, type.name, 'schema.json'), 'utf8'))
      if (!schema.attributes.slug) continue
      const titleField = ['title', 'name'].find((field) => schema.attributes[field]?.type === 'string')
      if (
        !titleField ||
        schema.kind !== 'collectionType' ||
        !['string', 'uid'].includes(schema.attributes.slug.type) ||
        schema.attributes.slug.pluginOptions?.i18n?.localized
      ) {
        throw new Error(`Unsupported slug schema: ${api.name}.${type.name}`)
      }
      collections.push({
        endpoint: `/api/${schema.info.pluralName}`,
        titleField,
        localized: schema.pluginOptions?.i18n?.localized === true,
        draftAndPublish: schema.options?.draftAndPublish === true,
      })
    }
  }
  if (!collections.length) throw new Error('No content types with a slug field found')
  return collections.sort((a, b) => compare(a.endpoint, b.endpoint))
}

export function planSlugs(rows) {
  const documents = new Map()
  for (const row of rows) {
    if (!row.document_id || !row.id) throw new Error('A content row has no document ID or row ID')
    const versions = documents.get(row.document_id) ?? []
    versions.push(row)
    documents.set(row.document_id, versions)
  }
  const sources = [...documents]
    .map(([documentId, versions]) => {
      const ordered = [...versions].sort(
        (a, b) =>
          Number(b.locale === 'pl') - Number(a.locale === 'pl') ||
          compare(a.locale ?? '', b.locale ?? '') ||
          Number(b.published_at != null) - Number(a.published_at != null) ||
          compare(a.id, b.id),
      )
      const source = ordered[0]
      if (typeof source.title !== 'string' || !source.title.trim()) {
        throw new Error(`Document ${documentId} (${source.locale}) has no source title`)
      }
      const base = slugify(source.title, { lower: true, strict: true })
      if (!base) throw new Error(`Document ${documentId} (${source.locale}) produces an empty slug`)
      return { documentId, versions, source, base }
    })
    .sort(
      (a, b) =>
        Number(b.source.locale === 'pl') - Number(a.source.locale === 'pl') || compare(a.documentId, b.documentId),
    )

  const used = new Set()
  return sources.map(({ documentId, versions, source, base }) => {
    let slug = base
    let suffix = 0
    while (used.has(slug)) slug = `${base}-${++suffix}`
    if (slug.length > 255) throw new Error(`Document ${documentId} produces a slug longer than 255 characters`)
    used.add(slug)
    return {
      documentId,
      locale: source.locale,
      slug,
      rows: versions,
      changed: versions.some((row) => row.slug !== slug),
    }
  })
}

async function readCollection(api, collection, locales) {
  const rows = []
  for (const locale of collection.localized ? locales : [undefined]) {
    for (const status of collection.draftAndPublish ? ['draft', 'published'] : [undefined]) {
      const seen = new Set()
      for (let page = 1; ; page += 1) {
        const { data, meta } = await api(collection.endpoint, {
          ...(locale ? { locale } : {}),
          ...(status ? { status } : {}),
          'fields[0]': collection.titleField,
          'fields[1]': 'slug',
          ...(collection.localized ? { 'fields[2]': 'locale' } : {}),
          ...(collection.draftAndPublish ? { 'fields[3]': 'publishedAt' } : {}),
          'pagination[page]': page,
          'pagination[pageSize]': 100,
          sort: 'id:asc',
        })
        const pagination = meta?.pagination
        if (
          !Array.isArray(data) ||
          !Number.isInteger(pagination?.pageCount) ||
          pagination.pageCount < 0 ||
          pagination.page !== page
        ) {
          throw new Error(`Invalid paginated response from ${collection.endpoint}`)
        }
        for (const entry of data) {
          if (
            !entry.id ||
            !entry.documentId ||
            !Object.hasOwn(entry, 'slug') ||
            (locale && entry.locale !== locale) ||
            (status &&
              (!Object.hasOwn(entry, 'publishedAt') || (status === 'published') !== (entry.publishedAt != null))) ||
            seen.has(entry.documentId)
          ) {
            throw new Error(`Invalid or duplicate document in ${collection.endpoint} (${locale}, ${status})`)
          }
          seen.add(entry.documentId)
          rows.push({
            id: entry.id,
            document_id: entry.documentId,
            title: entry[collection.titleField],
            slug: entry.slug,
            locale: entry.locale ?? null,
            published_at: entry.publishedAt ?? null,
          })
        }
        if (page >= pagination.pageCount) break
        if (!data.length) throw new Error(`Empty page before the end of ${collection.endpoint}`)
      }
    }
  }
  return rows
}

async function writeSlug(api, collection, document, slug) {
  const locales = [...new Set(document.rows.map((row) => row.locale))].sort(
    (a, b) => Number(b === 'pl') - Number(a === 'pl') || compare(a ?? '', b ?? ''),
  )
  for (const locale of locales) {
    const published = document.rows.some((row) => row.locale === locale && row.published_at != null)
    const { data } = await api(
      `${collection.endpoint}/${encodeURIComponent(document.documentId)}`,
      {
        ...(collection.localized ? { locale } : {}),
        ...(collection.draftAndPublish ? { status: published ? 'published' : 'draft' } : {}),
      },
      { method: 'PUT', data: { slug } },
    )
    if (
      data?.documentId !== document.documentId ||
      data.slug !== slug ||
      (collection.localized && data.locale !== locale) ||
      (collection.draftAndPublish && (!Object.hasOwn(data, 'publishedAt') || (data.publishedAt != null) !== published))
    ) {
      throw new Error(`Slug update verification failed for ${collection.endpoint}/${document.documentId} (${locale})`)
    }
  }
}

export async function regenerateSlugs({
  url,
  token,
  collections,
  apply = false,
  fetchImpl = fetch,
  log = console.log,
}) {
  const base = new URL(url)
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('CMS URL must be HTTP(S) without credentials, query strings or fragments')
  }
  if (!token) throw new Error('Set STRAPI_V5_API_TOKEN')
  const api = apiClient(base.href.replace(/\/$/, ''), token, fetchImpl)
  let locales = []
  if (collections.some((collection) => collection.localized)) {
    const response = await api('/api/i18n/locales')
    if (
      !Array.isArray(response) ||
      !response.length ||
      response.some((locale) => typeof locale.code !== 'string' || !locale.code)
    ) {
      throw new Error('Unable to read configured CMS locales')
    }
    locales = [...new Set(response.map((locale) => locale.code))].sort(
      (a, b) => Number(b === 'pl') - Number(a === 'pl') || compare(a, b),
    )
  }
  const plans = []
  for (const collection of collections) {
    const rows = await readCollection(api, collection, locales)
    plans.push({ ...collection, documents: planSlugs(rows) })
  }
  for (const collection of plans) {
    for (const document of collection.documents) {
      log(
        JSON.stringify({
          collection: collection.endpoint,
          documentId: document.documentId,
          sourceLocale: document.locale,
          fallback: Boolean(document.locale && document.locale !== 'pl'),
          previous: [...new Set(document.rows.map((row) => row.slug))],
          slug: document.slug,
          changed: document.changed,
        }),
      )
    }
  }
  if (!apply) return plans

  log(
    'Applying via REST: timestamps change and existing published locales republish their drafts. This is NOT a transaction.',
  )
  for (const collection of plans) {
    const changed = collection.documents.filter((document) => document.changed)
    const desired = new Map(collection.documents.map((document) => [document.slug, document.documentId]))
    const reserved = new Set([
      ...desired.keys(),
      ...collection.documents.flatMap((document) => document.rows.map((row) => row.slug)),
    ])
    // Free slugs owned by another document before assigning final values (including swaps).
    for (const document of changed) {
      if (!document.rows.some((row) => desired.has(row.slug) && desired.get(row.slug) !== document.documentId)) continue
      let temporary
      do {
        temporary = `slug-repair-${randomUUID()}`
      } while (reserved.has(temporary))
      reserved.add(temporary)
      log(`Temporarily freeing a conflicting slug on ${collection.endpoint}/${document.documentId}`)
      await writeSlug(api, collection, document, temporary)
    }
    for (const document of changed) {
      await writeSlug(api, collection, document, document.slug)
    }
    // Shared-field synchronization and later writes may affect previously updated translations.
    const actual = await readCollection(api, collection, locales)
    for (const document of collection.documents) {
      const versions = actual.filter((row) => row.document_id === document.documentId)
      const expectedVersions = new Set(
        document.rows.map((row) => JSON.stringify([row.locale, row.published_at != null])),
      )
      const actualVersions = new Set(versions.map((row) => JSON.stringify([row.locale, row.published_at != null])))
      if (
        versions.some((row) => row.slug !== document.slug) ||
        actualVersions.size !== expectedVersions.size ||
        [...expectedVersions].some((version) => !actualVersions.has(version))
      ) {
        throw new Error(`Final slug verification failed for ${collection.endpoint}/${document.documentId}`)
      }
    }
  }
  return plans
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    console.log(
      'Usage: yarn regenerate:slugs [--apply]\n' +
        'Uses the existing REST API. Set STRAPI_V5_API_TOKEN; optionally set STRAPI_V5_URL.\n' +
        'Default: read-only preview. Prefer pl, then another locale alphabetically; prefer published over draft.\n' +
        'Back up and pause CMS writes before --apply. Published locales republish drafts; timestamps change.\n' +
        'No database connection or deployment is needed. No .env files are read.',
    )
    return
  }
  const collections = await slugCollections()
  const plans = await regenerateSlugs({
    url: process.env.STRAPI_V5_URL || 'https://cms-new.pzkogrodek.cz',
    token: process.env.STRAPI_V5_API_TOKEN,
    collections,
    apply: values.apply,
  })
  const changed = plans.flatMap((plan) => plan.documents).filter((document) => document.changed).length
  console.log(
    values.apply
      ? `Repaired and verified slugs for ${changed} documents.`
      : `Preview: ${changed} documents need repair. No data changed. Back up and pause CMS writes before --apply.`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      `Slug repair stopped: ${error.message}. If applying, earlier writes may remain; inspect the CMS before retrying.`,
    )
    process.exitCode = 1
  })
}
