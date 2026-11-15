import { pathToFileURL } from 'node:url'
import slugify from 'slugify'
import { toBlocks } from './event-blocks.mjs'
import { loadState } from './event-migration-state.mjs'
import { mediaFromV4, migrate, transferBlocks } from './migrate-events.mjs'

const populateContent = {
  'populate[image]': 'true',
  'populate[content][on][page.page][populate]': '*',
  'populate[content][on][page.gallery][populate]': 'gallery',
  'populate[content][on][page.event-detail][populate]': 'event',
  'populate[content][on][page.youtube][populate]': '*',
}

function pageContent(content, sourceUrl, locale) {
  if (typeof content === 'string') {
    return [{ __component: 'page.page', text: toBlocks(content, sourceUrl) }]
  }
  if (content === null) return []
  if (!Array.isArray(content)) throw new Error('Expected a populated content dynamic zone or rich-text string')
  return content.map((component) => {
    switch (component.__component) {
    case 'page.page':
      if (!Object.hasOwn(component, 'text')) throw new Error('Missing page.page.text')
      return { __component: component.__component, text: toBlocks(component.text, sourceUrl) }
    case 'page.youtube':
      if (typeof component.url !== 'string' || !component.url.trim()) throw new Error('Missing YouTube URL')
      return { __component: component.__component, url: component.url }
    case 'page.gallery':
      if (!Array.isArray(component.gallery?.data)) throw new Error('Missing populated gallery media array')
      return {
        __component: component.__component,
        gallery: component.gallery.data.map((file) => mediaFromV4({ data: file })),
      }
    case 'page.event-detail': {
      if (!component.event || !Object.hasOwn(component.event, 'data')) {
        throw new Error('Missing populated event-detail relation')
      }
      const event = component.event.data
      if (event && (!event.id || !event.attributes)) throw new Error('Invalid populated event-detail relation')
      return {
        __component: component.__component,
        event: event ? { sourceId: event.id, locale: event.attributes.locale || locale } : null,
      }
    }
    default:
      throw new Error(`Unsupported page component ${component.__component}`)
    }
  })
}

export function preparePages(rows, sourceUrl) {
  const seen = new Set()
  return rows.map(({ id, attributes: page }) => {
    try {
      if (!id || !page?.publishedAt) throw new Error('Source returned a draft or invalid v4 page')
      if (seen.has(id)) throw new Error('Duplicate source page ID')
      seen.add(id)
      if (!page.locale || !page.title?.trim() || !page.description?.trim()) {
        throw new Error('Page requires a locale, title and description')
      }
      if (!Array.isArray(page.localizations?.data)) throw new Error('Missing populated localizations')
      const image = mediaFromV4(page.image)
      if (!image) throw new Error('Page requires a cover image in the v5 schema')
      return {
        id, locale: page.locale, slug: page.slug,
        relatedIds: page.localizations.data.map((entry) => entry.id),
        data: {
          title: page.title, description: page.description, image,
          content: pageContent(page.content, sourceUrl, page.locale),
        },
      }
    } catch (error) {
      throw new Error(`Page ${id}: ${error.message}`)
    }
  })
}

async function resolveEvents(pages, context, eventStatePath) {
  const relations = pages.flatMap((page) => page.data.content
    .filter((component) => component.__component === 'page.event-detail' && component.event)
    .map((component) => ({ component, locale: page.locale })))
  if (!relations.length) return
  const state = await loadState(eventStatePath, context.sourceUrl, context.targetUrl)
  const resolved = new Map()
  for (const { component, locale } of relations) {
    const { sourceId, locale: sourceLocale } = component.event
    const mapping = state.documents[sourceId]
    if (!mapping || mapping.locale !== sourceLocale) {
      throw new Error(`Missing migrated event ${sourceId} (${sourceLocale}). Run the event migration or reconcile its state file first.`)
    }
    const key = JSON.stringify([mapping.documentId, locale])
    if (!resolved.has(key)) {
      const { data } = await context.target(`/api/events/${encodeURIComponent(mapping.documentId)}`, {
        locale, status: 'published',
      })
      if (data?.documentId !== mapping.documentId || data.locale !== locale || !data.publishedAt) {
        throw new Error(`Mapped event ${sourceId} is not published in the page locale ${locale}`)
      }
      resolved.set(key, { documentId: mapping.documentId, locale })
    }
    component.event = { connect: [resolved.get(key)] }
  }
}

function pageImages(page) {
  return [
    page.data.image,
    ...page.data.content.flatMap((component) => {
      if (component.__component === 'page.gallery') return component.gallery
      if (component.__component === 'page.page') {
        return component.text.filter((block) => block.type === 'image').map((block) => block.image)
      }
      return []
    }),
  ]
}

async function transferPage(page, transfer) {
  const data = { ...page.data, image: (await transfer(page.data.image)).id, content: [] }
  for (const component of page.data.content) {
    if (component.__component === 'page.page') {
      data.content.push({ ...component, text: await transferBlocks(component.text, transfer) })
    } else if (component.__component === 'page.gallery') {
      const gallery = []
      for (const image of component.gallery) gallery.push((await transfer(image)).id)
      data.content.push({ ...component, gallery })
    } else {
      data.content.push(component)
    }
  }
  return data
}

function normalizePage(field, value) {
  if (field !== 'content' || !Array.isArray(value)) return value
  return value.map((component) => {
    const { id, ...data } = component
    void id
    if (data.__component === 'page.gallery') return { __component: data.__component }
    if (data.__component === 'page.event-detail') {
      const event = data.event?.connect?.[0] ?? data.event
      return {
        __component: data.__component,
        event: event ? { documentId: event.documentId, locale: event.locale } : null,
      }
    }
    return data
  })
}

export async function migratePages(options) {
  const eventStatePath = options.eventStatePath || '.migration-state/events.json'
  const profile = {
    contentType: 'api::page.page',
    endpoint: '/api/pages',
    localizedFields: ['title', 'description', 'content'],
    sharedFields: ['image'],
    populateSource: { ...populateContent, 'populate[localizations]': 'true' },
    populateTarget: populateContent,
    prepare: async (rows, sourceUrl, context) => {
      const pages = preparePages(rows, sourceUrl)
      await resolveEvents(pages, context, eventStatePath)
      return pages
    },
    images: pageImages,
    transfer: transferPage,
    normalize: normalizePage,
    // The page schema requires a slug before the database lifecycle generates the final one.
    createData: (data, page) => ({
      ...data,
      slug: `${slugify(data.title, { lower: true, strict: true }) || 'page'}-${page.id}-${page.locale}`,
    }),
  }
  return migrate({ ...options, statePath: options.statePath || '.migration-state/pages.json', profile })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: yarn migrate:pages [--apply]\nDefault: read-only preview. Set STRAPI_V4_API_TOKEN and STRAPI_V5_API_TOKEN.\nOptional: STRAPI_V4_URL, STRAPI_V5_URL, STRAPI_MEDIA_ORIGINS, STRAPI_PAGE_MIGRATION_STATE, STRAPI_EVENT_MIGRATION_STATE.\nPage state defaults to .migration-state/pages.json. Event relations require the event migration state. See README.md.')
    return
  }
  if (args.some((arg) => arg !== '--apply')) throw new Error('Unknown argument. Use --help.')
  await migratePages({
    sourceUrl: process.env.STRAPI_V4_URL || 'https://cms.pzkogrodek.cz',
    targetUrl: process.env.STRAPI_V5_URL || 'https://cms-new.pzkogrodek.cz',
    sourceToken: process.env.STRAPI_V4_API_TOKEN,
    targetToken: process.env.STRAPI_V5_API_TOKEN,
    mediaOrigins: (process.env.STRAPI_MEDIA_ORIGINS || '').split(',').filter(Boolean),
    statePath: process.env.STRAPI_PAGE_MIGRATION_STATE,
    eventStatePath: process.env.STRAPI_EVENT_MIGRATION_STATE,
    apply: args.includes('--apply'),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Page migration stopped: ${error.message}`)
    process.exitCode = 1
  })
}
