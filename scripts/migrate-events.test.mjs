import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test, { after } from 'node:test'
import ts from 'typescript'
import { toBlocks } from './event-blocks.mjs'
import { groupEvents, mediaTransfer, migrate, planMigration, prepareEvents } from './migrate-events.mjs'
import { loadState, saveState } from './event-migration-state.mjs'

const require = createRequire(import.meta.url)
const { blocksValidator } = require(join(dirname(require.resolve('@strapi/core')), 'services', 'entity-validator', 'blocks-validator.js'))
const sourceUrl = 'https://old.example.test'
const targetUrl = 'https://new.example.test'
const text = (value) => ({ type: 'text', text: value })

const uploadedImage = {
  id: 7, name: 'photo.png', alternativeText: 'Photo', caption: null,
  url: '/uploads/photo.png', width: 10, height: 20, formats: null,
  hash: 'photo', ext: '.png', mime: 'image/png', size: 1,
  previewUrl: null, provider: 'local', provider_metadata: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

function row(id = 1, locale = 'pl', attributes = {}) {
  return {
    id,
    attributes: {
      name: `Event ${id}`, slug: `original-${locale}`, locale,
      start: '2026-01-01T12:00:00.000Z', end: null, inBuilding: false,
      publishedAt: '2026-01-01T00:00:00.000Z', description: 'Description',
      content: 'Hello **world**.\n\n![Inline photo](/uploads/photo.png)',
      image: { data: { id: 8, attributes: { url: '/uploads/photo.png', alternativeText: 'Cover' } } },
      localizations: { data: [] }, ...attributes,
    },
  }
}

function fixture(rows = [row()], options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'event-migration-test-'))
  after(() => rmSync(directory, { recursive: true, force: true }))
  const statePath = join(directory, 'state.json')
  const calls = []
  const documents = []
  const files = []
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    calls.push({ url, method, init })
    if (url.origin === sourceUrl && url.pathname === '/uploads/photo.png') {
      assert.equal(init.headers, undefined, 'media downloads must not receive API credentials')
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
    }
    assert.equal(init.redirect, 'error')
    if (url.origin === sourceUrl && url.pathname === '/api/events') {
      assert.equal(url.searchParams.get('locale'), 'all')
      assert.equal(url.searchParams.get('publicationState'), 'live')
      assert.equal(url.searchParams.get('populate[0]'), 'image')
      const page = Number(url.searchParams.get('pagination[page]'))
      return json({ data: rows.slice(page - 1, page), meta: { pagination: { pageCount: rows.length } } })
    }
    assert.equal(url.origin, targetUrl)
    if (url.pathname === '/api/upload/files') {
      return json(files.filter((file) => file.name === url.searchParams.get('filters[name][$eq]')))
    }
    if (url.pathname === '/api/upload') {
      assert.equal(method, 'POST')
      const metadata = JSON.parse(init.body.get('fileInfo'))
      const file = { ...uploadedImage, ...metadata }
      files.push(file)
      return json([file])
    }
    if (url.pathname === '/api/events' && method === 'GET') {
      const data = documents.filter((entry) => entry.locale === url.searchParams.get('locale'))
      return json({
        data: data.map((entry) => ({ ...entry, publishedAt: url.searchParams.get('status') === 'draft' ? null : entry.publishedAt })),
        meta: { pagination: { pageCount: 1 } },
      })
    }
    if (url.pathname.startsWith('/api/events')) {
      const documentId = url.pathname.split('/')[3] ?? `doc-${documents.length + 1}`
      const locale = url.searchParams.get('locale')
      let entry = documents.find((entry) => entry.documentId === documentId && entry.locale === locale)
      if (method !== 'GET') {
        assert.equal(url.searchParams.get('status'), 'published')
        const { data } = JSON.parse(init.body)
        assert.equal('slug' in data, false)
        const sibling = documents.find((entry) => entry.documentId === documentId)
        if (!entry) {
          if (sibling) {
            for (const field of ['start', 'end', 'image', 'inBuilding']) assert.equal(field in data, false)
          }
          entry = { ...sibling, id: documents.length + 100, documentId, locale, slug: `generated-${locale}` }
          documents.push(entry)
        }
        Object.assign(entry, data, { publishedAt: '2026-02-01T00:00:00.000Z' })
        if (Object.hasOwn(data, 'image')) entry.image = data.image ? files.find((file) => file.id === data.image) : null
        if (options.replaceSlug) entry.slug = 'unexpected-slug'
        blocksValidator().validateSync(entry.content, { strict: true })
        if (options.failOnce) {
          options.failOnce = false
          throw new Error('Connection lost after write')
        }
        if (options.corruptOnce) {
          options.corruptOnce = false
          return json({ data: { ...entry, name: 'Unexpected name' } })
        }
      }
      assert.ok(entry)
      return json({ data: options.omitImage ? { ...entry, image: undefined } : entry })
    }
    throw new Error(`Unexpected mock request: ${method} ${url.pathname}`)
  }
  return {
    calls, documents, files, statePath,
    run: (apply = false) => migrate({
      sourceUrl, targetUrl, sourceToken: 'source-test-token', targetToken: 'target-test-token',
      fetchImpl, apply, statePath, log: () => {},
    }),
  }
}

test('converts Markdown and embedded HTML into schema-valid formatted Blocks', () => {
  const result = toBlocks('# Heading\n\n**Bold** and <u>underlined</u> &amp; [link](/about)\n\n> Quote\n\n```js\nconst x = 1\n```\n\n- One\n  - Nested\n- Two', sourceUrl)
  blocksValidator().validateSync(result, { strict: true })
  assert.equal(result[0].type, 'heading')
  assert.equal(result[0].level, 1)
  assert.ok(result[1].children.some((child) => child.bold && child.text === 'Bold'))
  assert.ok(result[1].children.some((child) => child.underline && child.text === 'underlined'))
  assert.ok(result[1].children.some((child) => child.text?.includes(' & ')))
  assert.equal(result[1].children.find((child) => child.type === 'link').url, `${sourceUrl}/about`)
  assert.equal(result[2].type, 'quote')
  assert.deepEqual(result[3], { type: 'code', language: 'js', children: [text('const x = 1')] })
  assert.equal(result[4].children[1].type, 'list')
})

test('preserves HTML text, inline whitespace, line breaks and image placement', () => {
  const result = toBlocks('<p>Before<img src="/uploads/photo.png" alt="Photo">After<br>Next</p>\n<ul><li><b>One</b> <i>two</i></li></ul>', sourceUrl)
  assert.deepEqual(result.map((block) => block.type), ['paragraph', 'image', 'paragraph', 'list'])
  assert.equal(result[1].image.url, `${sourceUrl}/uploads/photo.png`)
  assert.equal(result[2].children.map((child) => child.text).join(''), 'After\nNext')
  assert.equal(result[3].children[0].children.map((child) => child.text).join(''), 'One two')
  assert.deepEqual(toBlocks(null, sourceUrl), [])
  assert.deepEqual(toBlocks('', sourceUrl), [])
})

test('ignores HTML styles while retaining text, semantic formatting, links and images', () => {
  const styled = '<style>.custom { color: red }</style><div class="custom" style="text-align:center"><p style="color:blue"><strong style="font-size:20px">Bold</strong> <span style="font-weight:bold">plain<style>span { display: none }</style></span> <a style="color:red" href="/about">Link</a></p><img style="width:10px" src="/photo.png"></div>'
  const unstyled = '<div><p><strong>Bold</strong> <span>plain</span> <a href="/about">Link</a></p><img src="/photo.png"></div>'
  assert.deepEqual(toBlocks(styled, sourceUrl), toBlocks(unstyled, sourceUrl))
  assert.deepEqual(toBlocks('<style>body { color:red }</style>', sourceUrl), [])
})

test('flattens nested links using the first href and all formatted text', () => {
  const cases = [
    ['<a href="/first">Before <strong><a href="/second">bold</a></strong><br>After</a>', '/first'],
    ['<a>Before <strong><a href="/first">bold</a></strong><br><a href="/second">After</a></a>', '/first'],
    ['<a href=" ">Before <strong><a><a href="/first">bold</a></a></strong><br>After</a>', '/first'],
  ]
  for (const [html, href] of cases) {
    const blocks = toBlocks(html, sourceUrl)
    blocksValidator().validateSync(blocks, { strict: true })
    assert.equal(blocks[0].children.length, 1)
    const link = blocks[0].children[0]
    assert.equal(link.url, `${sourceUrl}${href}`)
    assert.ok(link.children.every((child) => child.type === 'text'))
    assert.equal(link.children.map((child) => child.text).join(''), 'Before bold\nAfter')
    assert.ok(link.children.some((child) => child.text === 'bold' && child.bold))
  }
})

test('keeps sibling links separate and retains text when no nested anchor has a href', () => {
  const blocks = toBlocks('<a>Before <a><em>inner</em></a> after</a> <a href="/one">One</a> <a href="/two">Two</a>', sourceUrl)
  blocksValidator().validateSync(blocks, { strict: true })
  const children = blocks[0].children
  assert.deepEqual(children.filter((child) => child.type === 'link').map((child) => child.url), [
    `${sourceUrl}/one`, `${sourceUrl}/two`,
  ])
  assert.ok(children.some((child) => child.text === 'inner' && child.italic))
  assert.equal(children.filter((child) => child.type === 'text').map((child) => child.text).join(''), 'Before inner after  ')
  assert.throws(() => toBlocks('<a><a href="javascript:alert(1)">Unsafe</a></a>', sourceUrl), /protocol/)
})

test('fails explicitly on unsupported content instead of silently dropping it', () => {
  for (const input of ['<table><tr><td>Important</td></tr></table>', '<iframe src="/movie"></iframe>', '<div style="color:red" data-embed="video">Video</div>', '3. Third', '<ol reversed><li>Third</li></ol>', '> > Nested quote', '<script>alert(1)</script>']) {
    assert.throws(() => toBlocks(input, sourceUrl))
  }
  assert.throws(() => toBlocks('<a href="javascript:alert(1)">Link</a>', sourceUrl), /protocol/)
})

test('groups translations even when linked through an unpublished locale', () => {
  const events = prepareEvents([
    row(1, 'pl', { localizations: { data: [{ id: 3 }] } }),
    row(2, 'cs', { localizations: { data: [{ id: 3 }] } }),
  ], sourceUrl)
  assert.equal(groupEvents(events).length, 1)
  const target = [{ documentId: 'existing', locale: 'cs', slug: 'original-cs' }]
  assert.equal(planMigration(groupEvents(events), target)[0].documentId, 'existing')
  assert.throws(() => planMigration(groupEvents(events), [
    ...target, { documentId: 'other', locale: 'pl', slug: 'original-pl' },
  ]), /separate v5 documents/)
  assert.throws(() => planMigration(groupEvents(events), [
    ...target, { documentId: 'existing', locale: 'pl', slug: 'different' },
  ]), /conflicting slug/)
})

test('allows an omitted, null or empty end date and validates supplied dates', () => {
  const missingEnd = row()
  delete missingEnd.attributes.end
  for (const event of [missingEnd, row(1, 'pl', { end: null }), row(1, 'pl', { end: '' })]) {
    assert.equal(prepareEvents([event], sourceUrl)[0].data.end, null)
  }
  const end = '2026-01-01T18:00:00.000Z'
  assert.equal(prepareEvents([row(1, 'pl', { end })], sourceUrl)[0].data.end, end)
  assert.throws(() => prepareEvents([row(1, 'pl', { end: 'invalid' })], sourceUrl), /Invalid dates/)
  assert.throws(() => prepareEvents([row(1, 'pl', { start: null })], sourceUrl), /Invalid dates/)
})

test('defaults unset inBuilding to true without overriding explicit booleans', () => {
  const missing = row()
  delete missing.attributes.inBuilding
  assert.equal(prepareEvents([missing], sourceUrl)[0].data.inBuilding, true)
  for (const [value, expected] of [[undefined, true], [null, true], [true, true], [false, false]]) {
    assert.equal(prepareEvents([row(1, 'pl', { inBuilding: value })], sourceUrl)[0].data.inBuilding, expected)
  }
  assert.throws(() => prepareEvents([row(1, 'pl', { inBuilding: 'false' })], sourceUrl), /Invalid dates or inBuilding/)
})

test('rejects incomplete source records and inconsistent non-localized fields', () => {
  assert.throws(() => prepareEvents([row(1, 'pl', { image: undefined })], sourceUrl), /populated event image/)
  assert.throws(() => prepareEvents([row(1, 'pl', { publishedAt: null })], sourceUrl), /draft/)
  assert.throws(() => prepareEvents([row(), row()], sourceUrl), /Duplicate/)
  const missingContent = row()
  delete missingContent.attributes.content
  assert.throws(() => prepareEvents([missingContent], sourceUrl), /missing content/)
  const events = prepareEvents([
    row(1, 'pl', { localizations: { data: [{ id: 2 }] } }),
    row(2, 'cs', { inBuilding: true }),
  ], sourceUrl)
  assert.throws(() => groupEvents(events), /non-localized inBuilding/)
})

test('dry run paginates published source locales without downloads or writes', async () => {
  const mock = fixture([row(1, 'pl'), row(2, 'cs')])
  await mock.run()
  assert.ok(mock.calls.every((call) => call.method === 'GET' && call.url.pathname === '/api/events'))
  assert.equal(mock.calls.filter((call) => call.url.origin === sourceUrl).length, 2)
  assert.equal(mock.documents.length, 0)
  assert.equal(mock.files.length, 0)
  assert.equal(existsSync(mock.statePath), false)
})

test('apply migrates localized published documents and images; reruns update without duplicates', async () => {
  const mock = fixture([
    row(1, 'pl', { localizations: { data: [{ id: 2 }] } }),
    row(2, 'cs', { localizations: { data: [{ id: 1 }] } }),
  ])
  await mock.run(true)
  assert.equal(mock.documents.length, 2)
  assert.equal(new Set(mock.documents.map((entry) => entry.documentId)).size, 1)
  assert.equal(mock.files.length, 1)
  assert.equal(mock.documents[0].slug, 'generated-pl')
  assert.equal(mock.documents[0].image.id, 7)
  const image = mock.documents[0].content.find((block) => block.type === 'image').image
  assert.equal(image.url, `${targetUrl}/uploads/photo.png`)
  assert.equal(image.alternativeText, 'Inline photo')
  assert.equal('id' in image, false)
  await mock.run(true)
  assert.equal(mock.documents.length, 2)
  assert.equal(mock.files.length, 1)
  assert.equal(mock.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/events').length, 1)
})

test('updates existing draft matches and clears removed content and cover images', async () => {
  const mock = fixture([row(1, 'pl', { content: null, image: { data: null } })])
  mock.documents.push({
    id: 100, documentId: 'existing', locale: 'pl', slug: 'original-pl', publishedAt: null,
    content: [{ type: 'paragraph', children: [text('Old content')] }], image: uploadedImage,
  })
  await mock.run(true)
  assert.equal(mock.documents.length, 1)
  assert.deepEqual(mock.documents[0].content, [])
  assert.equal(mock.documents[0].image, null)
  assert.ok(mock.documents[0].publishedAt)
})

test('does not fail when the target omits the cover image from responses', async () => {
  const mock = fixture([row()], { omitImage: true })
  await mock.run(true)
  assert.equal(mock.documents[0].image.id, 7)
})

test('uploads with the original media name or decoded URL filename, without a hash prefix', async () => {
  for (const [source, expected] of [
    [{ name: 'Original photo.png', url: '/uploads/stored_hash.png' }, 'Original photo.png'],
    [{ url: '/uploads/Inline%20photo.png' }, 'Inline photo.png'],
  ]) {
    const requests = []
    const transfer = mediaTransfer(async (path, params, options) => {
      requests.push({ path, params })
      if (path === '/api/upload/files') return []
      assert.equal(options.form.get('files').name, expected)
      assert.equal(JSON.parse(options.form.get('fileInfo')).name, expected)
      return [{ ...uploadedImage, name: expected }]
    }, sourceUrl, targetUrl, new Set([sourceUrl]),
    async () => new Response('image', { headers: { 'Content-Type': 'image/png' } }))
    const file = await transfer(source)
    assert.equal(file.name, expected)
    assert.equal(requests[0].params['filters[name][$eq]'], expected)
  }
})

test('preflight rejects unsupported content and untrusted media before any writes', async () => {
  for (const content of ['<table><tr><td>Data</td></tr></table>', '![External](https://untrusted.example.test/file.png)']) {
    const mock = fixture([row(1, 'pl', { content })])
    await assert.rejects(mock.run(true))
    assert.ok(mock.calls.every((call) => call.method === 'GET'))
    assert.equal(mock.files.length, 0)
  }
})

test('persists ID mappings and updates events with changed or missing source slugs', async () => {
  const source = row(1, 'pl', { slug: null })
  const mock = fixture([source], { replaceSlug: true })
  await mock.run(true)
  const state = await loadState(mock.statePath, sourceUrl, targetUrl)
  assert.deepEqual(state.documents, { 1: { documentId: mock.documents[0].documentId, locale: 'pl' } })
  assert.equal(state.pending, null)
  source.attributes.slug = 'changed-source-slug'
  await mock.run(true)
  assert.equal(mock.documents.length, 1)
  assert.equal(mock.documents[0].slug, 'unexpected-slug')
  await assert.rejects(loadState(mock.statePath, sourceUrl, 'https://other.example.test'), /different CMS/)
  mock.documents.length = 0
  await assert.rejects(mock.run(true), /Saved target.*missing/)
})

test('saves target identity before verification fails, allowing a safe retry', async () => {
  const mock = fixture([row()], { corruptOnce: true })
  await assert.rejects(mock.run(true), /did not preserve name/)
  await mock.run(true)
  assert.equal(mock.documents.length, 1)
})

test('blocks ambiguous retries until a pending write is reconciled', async () => {
  const mock = fixture([row()], { failOnce: true })
  await assert.rejects(mock.run(true), /Connection lost/)
  await assert.rejects(mock.run(true), /uncertain outcome/)
  assert.equal(mock.documents.length, 1)
  const state = JSON.parse(readFileSync(mock.statePath, 'utf8'))
  assert.deepEqual(state.pending, { sourceId: 1, locale: 'pl', documentId: null })
  state.documents[1] = { documentId: mock.documents[0].documentId, locale: 'pl' }
  state.pending = null
  await saveState(mock.statePath, state)
  await mock.run(true)
  assert.equal(mock.documents.length, 1)
})

test('rejects non-image downloads and oversized images before uploading', async () => {
  for (const headers of [
    { 'Content-Type': 'text/html' },
    { 'Content-Type': 'image/png', 'Content-Length': String(21 * 1024 * 1024) },
  ]) {
    let writes = 0
    const transfer = mediaTransfer(async () => { writes += 1 }, sourceUrl, targetUrl,
      new Set([sourceUrl]), async () => new Response('data', { headers }))
    await assert.rejects(transfer({ url: '/uploads/photo.png' }))
    assert.equal(writes, 0)
  }
})

test('event lifecycle preserves supplied slugs and still generates missing ones', async () => {
  const source = readFileSync(new URL('../src/api/event/content-types/event/lifecycles.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } })
  const exports = {}
  let generated = 0
  runInNewContext(outputText, {
    exports, strapi: {},
    require: () => ({ createSlug: async () => { generated += 1; return 'generated' } }),
  })
  const original = { params: { data: { name: 'Event', slug: 'original' } } }
  await exports.default.beforeCreate(original)
  assert.equal(original.params.data.slug, 'original')
  assert.equal(generated, 0)
  const missing = { params: { data: { name: 'Event' } } }
  await exports.default.beforeCreate(missing)
  assert.equal(missing.params.data.slug, 'generated')
  assert.equal(generated, 1)
})
