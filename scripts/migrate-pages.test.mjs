import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { loadState, saveState } from './event-migration-state.mjs'
import { migratePages, preparePages } from './migrate-pages.mjs'

const sourceUrl = 'https://old.example.test'
const targetUrl = 'https://new.example.test'
const media = (id, name) => ({
  id, attributes: { name, url: `/uploads/${name}`, alternativeText: name },
})

function row(id = 1, locale = 'pl', attributes = {}) {
  return {
    id,
    attributes: {
      title: `Page ${locale}`, slug: `old-${locale}`, description: 'Description', locale,
      publishedAt: '2026-01-01T00:00:00.000Z',
      image: { data: media(10, 'cover.png') },
      localizations: { data: [] },
      content: [
        { id: 100, __component: 'page.page', text: '# Heading\n\n**Text** <u>underlined</u>\n\n![Inline](/uploads/inline.png)' },
        { id: 101, __component: 'page.gallery', gallery: { data: [media(11, 'gallery.png')] } },
        { id: 102, __component: 'page.youtube', url: 'https://www.youtube.com/watch?v=example' },
        { id: 103, __component: 'page.event-detail', event: { data: { id: 42, attributes: { locale: 'pl' } } } },
      ],
      ...attributes,
    },
  }
}

function fixture(rows = [row()], options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'page-migration-test-'))
  after(() => rmSync(directory, { recursive: true, force: true }))
  const statePath = join(directory, 'pages.json')
  const eventStatePath = join(directory, 'events.json')
  const calls = []
  const documents = []
  const files = []
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    calls.push({ url, method, init })
    if (url.origin === sourceUrl && url.pathname.startsWith('/uploads/')) {
      assert.equal(init.headers, undefined)
      return new Response('image', { headers: { 'Content-Type': 'image/png' } })
    }
    if (url.origin === sourceUrl) {
      assert.equal(url.pathname, '/api/pages')
      assert.equal(url.searchParams.get('locale'), 'all')
      assert.equal(url.searchParams.get('publicationState'), 'live')
      assert.equal(url.searchParams.get('populate[content][on][page.gallery][populate]'), 'gallery')
      const page = Number(url.searchParams.get('pagination[page]'))
      return json({ data: rows.slice(page - 1, page), meta: { pagination: { pageCount: rows.length } } })
    }
    assert.equal(url.origin, targetUrl)
    if (url.pathname.startsWith('/api/events/')) {
      assert.equal(method, 'GET')
      assert.equal(url.pathname, '/api/events/event-document')
      return json({ data: { documentId: 'event-document', locale: url.searchParams.get('locale'), publishedAt: options.unpublishedEvent ? null : '2026-01-01' } })
    }
    if (url.pathname === '/api/upload/files') {
      return json(files.filter((file) => file.name === url.searchParams.get('filters[name][$eq]')))
    }
    if (url.pathname === '/api/upload') {
      const metadata = JSON.parse(init.body.get('fileInfo'))
      const file = {
        ...metadata, id: files.length + 200, url: `/uploads/${metadata.name}`,
        width: 10, height: 20, hash: metadata.name, ext: '.png', mime: 'image/png',
        size: 1, provider: 'local', createdAt: '2026-01-01', updatedAt: '2026-01-01',
      }
      files.push(file)
      return json([file])
    }
    if (url.pathname === '/api/pages' && method === 'GET') {
      return json({
        data: documents.filter((entry) => entry.locale === url.searchParams.get('locale')),
        meta: { pagination: { pageCount: 1 } },
      })
    }
    assert.ok(url.pathname.startsWith('/api/pages'))
    const documentId = url.pathname.split('/')[3] || `page-document-${documents.length + 1}`
    const locale = url.searchParams.get('locale')
    let entry = documents.find((item) => item.documentId === documentId && item.locale === locale)
    if (method !== 'GET') {
      assert.equal(url.searchParams.get('status'), 'published')
      const { data } = JSON.parse(init.body)
      for (const field of ['name', 'start', 'end', 'inBuilding']) assert.equal(field in data, false)
      if (!entry) {
        assert.ok(data.slug, 'page creation requires a generated slug candidate')
        assert.notEqual(data.slug, `old-${locale}`)
        const sibling = documents.find((item) => item.documentId === documentId)
        if (sibling) assert.equal('image' in data, false)
        entry = { ...sibling, id: documents.length + 300, documentId, locale }
        documents.push(entry)
      } else {
        assert.equal('slug' in data, false, 'updates must not replace the target slug')
      }
      Object.assign(entry, data, { slug: `generated-${locale}`, publishedAt: '2026-01-01' })
      if ('image' in data) entry.image = files.find((file) => file.id === data.image)
      entry.content = data.content.map((component, index) => {
        assert.equal('id' in component, false)
        const result = { ...component, id: index + 500 }
        if (component.__component === 'page.gallery') {
          result.gallery = component.gallery.map((id) => files.find((file) => file.id === id))
        }
        if (component.__component === 'page.event-detail' && component.event) {
          result.event = { id: 900, ...component.event.connect[0], publishedAt: '2026-01-01' }
        }
        return result
      })
      if (options.corruptText) entry.content[0].text = []
    }
    assert.ok(entry)
    const output = structuredClone(entry)
    // Media relations may be omitted by target permissions; migration does not verify them.
    delete output.image
    for (const component of output.content) {
      if (component.__component === 'page.gallery') delete component.gallery
    }
    return json({ data: output })
  }
  return {
    calls, documents, files, statePath, eventStatePath,
    mapEvent: () => saveState(eventStatePath, {
      version: 1, sourceUrl, targetUrl, documents: { 42: { documentId: 'event-document', locale: 'pl' } }, pending: null,
    }),
    run: (apply = false) => migratePages({
      sourceUrl, targetUrl, sourceToken: 'source-test', targetToken: 'target-test',
      statePath, eventStatePath, fetchImpl, apply, log: () => {},
    }),
  }
}

test('prepares dynamic-zone text, galleries, video and event components without source component IDs', () => {
  const [page] = preparePages([row()], sourceUrl)
  assert.equal(page.data.title, 'Page pl')
  assert.equal(page.data.content[0].text[0].type, 'heading')
  assert.equal(page.data.content[1].gallery[0].name, 'gallery.png')
  assert.equal(page.data.content[2].url, 'https://www.youtube.com/watch?v=example')
  assert.deepEqual(page.data.content[3].event, { sourceId: 42, locale: 'pl' })
  assert.ok(page.data.content.every((component) => !('id' in component)))
  assert.deepEqual(preparePages([row(1, 'pl', { content: 'Simple **text**' })], sourceUrl)[0].data.content[0].__component, 'page.page')
})

test('rejects unsupported components, unpopulated media and missing required page fields', () => {
  for (const attributes of [
    { content: [{ __component: 'page.unknown' }] },
    { content: [{ __component: 'page.gallery', gallery: { data: [{ id: 1, attributes: { title: 'Not media' } }] } }] },
    { content: [{ __component: 'page.event-detail' }] },
    { content: [{ __component: 'page.page', text: '<table><tr><td>Data</td></tr></table>' }] },
    { image: { data: null } }, { description: '' }, { title: '' }, { publishedAt: null },
  ]) assert.throws(() => preparePages([row(1, 'pl', attributes)], sourceUrl), /Page 1:/)
})

test('page preview paginates and resolves event mappings without writes or media downloads', async () => {
  const mock = fixture([row(1, 'pl'), row(2, 'cs')])
  await mock.mapEvent()
  await mock.run()
  assert.ok(mock.calls.every((call) => call.method === 'GET' && !call.url.pathname.startsWith('/uploads/')))
  assert.equal(mock.calls.filter((call) => call.url.origin === sourceUrl).length, 2)
  assert.equal(existsSync(mock.statePath), false)
})

test('migrates all page components, linked locales and media; reruns use separate saved page IDs', async () => {
  const mock = fixture([
    row(1, 'pl', { localizations: { data: [{ id: 2 }] } }),
    row(2, 'cs', { localizations: { data: [{ id: 1 }] } }),
  ])
  await mock.mapEvent()
  await mock.run(true)
  assert.equal(mock.documents.length, 2)
  assert.equal(new Set(mock.documents.map((entry) => entry.documentId)).size, 1)
  assert.deepEqual(mock.files.map((file) => file.name).sort(), ['cover.png', 'gallery.png', 'inline.png'])
  const content = mock.documents[0].content
  assert.deepEqual(content.map((component) => component.__component), ['page.page', 'page.gallery', 'page.youtube', 'page.event-detail'])
  assert.equal(content[0].text.find((block) => block.type === 'image').image.url, `${targetUrl}/uploads/inline.png`)
  assert.equal(content[1].gallery[0].name, 'gallery.png')
  assert.equal(content[3].event.documentId, 'event-document')
  assert.equal(content[3].event.locale, 'pl')
  assert.equal(mock.documents[1].content[3].event.locale, 'cs')
  const state = await loadState(mock.statePath, sourceUrl, targetUrl, 'api::page.page')
  assert.equal(state.documents[1].documentId, mock.documents[0].documentId)
  await assert.rejects(loadState(mock.statePath, sourceUrl, targetUrl), /content type/)
  await assert.rejects(loadState(mock.eventStatePath, sourceUrl, targetUrl, 'api::page.page'), /content type/)
  await mock.run(true)
  assert.equal(mock.documents.length, 2)
  assert.equal(mock.files.length, 3)
  assert.equal(mock.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/pages').length, 1)
})

test('event mappings are required only for nonempty event-detail components', async () => {
  const missing = fixture()
  await assert.rejects(missing.run(true), /Missing migrated event 42/)
  assert.ok(missing.calls.every((call) => call.method === 'GET'))
  const unpublished = fixture([row()], { unpublishedEvent: true })
  await unpublished.mapEvent()
  await assert.rejects(unpublished.run(true), /not published/)
  assert.ok(unpublished.calls.every((call) => call.method === 'GET'))
  const noRelation = fixture([row(1, 'pl', {
    content: [{ __component: 'page.page', text: 'Body' }, { __component: 'page.event-detail', event: { data: null } }],
  })])
  await noRelation.run(true)
  assert.equal(noRelation.documents[0].content[1].event, null)
  assert.equal(existsSync(noRelation.eventStatePath), false)
})

test('page text verification remains enabled despite skipping media relations and generated slugs', async () => {
  const mock = fixture([row()], { corruptText: true })
  await mock.mapEvent()
  await assert.rejects(mock.run(true), /did not preserve content/)
  const state = await loadState(mock.statePath, sourceUrl, targetUrl, 'api::page.page')
  assert.ok(state.documents[1])
  assert.equal(state.pending, null)
})
