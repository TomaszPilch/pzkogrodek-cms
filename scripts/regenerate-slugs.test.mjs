import assert from 'node:assert/strict'
import test from 'node:test'
import { planSlugs, regenerateSlugs, slugCollections } from './regenerate-slugs.mjs'

const row = (id, documentId, locale, title, publishedAt = null) => ({
  id,
  document_id: documentId,
  locale,
  title,
  published_at: publishedAt,
  slug: `broken-${id}`,
})

test('discovers every current slug collection and its title field', async () => {
  const collections = await slugCollections()
  assert.deepEqual(collections, [
    { endpoint: '/api/aktywny-emeryts', titleField: 'title', localized: true, draftAndPublish: false },
    { endpoint: '/api/events', titleField: 'name', localized: true, draftAndPublish: true },
    { endpoint: '/api/pages', titleField: 'title', localized: true, draftAndPublish: true },
  ])
})

test('uses Polish published titles for every translation and version, even when Polish is last', () => {
  const rows = [
    row(1, 'a', 'cs', 'Czech title', '2026-01-01'),
    row(2, 'a', 'pl', 'Polish draft'),
    row(3, 'a', 'pl', 'Polski opublikowany', '2026-01-01'),
    row(4, 'a', 'cs', 'Czech draft'),
  ]
  const [plan] = planSlugs(rows)
  assert.equal(plan.slug, 'polski-opublikowany')
  assert.equal(plan.locale, 'pl')
  assert.equal(plan.rows.length, 4)
  assert.equal(plan.changed, true)
})

test('Polish draft beats a published translation; absent Polish falls back deterministically', () => {
  const rows = [
    row(1, 'a', 'cs', 'Published translation', '2026-01-01'),
    row(2, 'a', 'pl', 'Polski szkic'),
    row(3, 'b', 'en', 'English', '2026-01-01'),
    row(4, 'b', 'cs', 'Cesky draft'),
    row(5, 'b', 'cs', 'Cesky published', '2026-01-01'),
    row(6, 'c', 'cs', 'Only draft'),
  ]
  const plans = planSlugs(rows)
  assert.deepEqual(
    plans.map(({ slug }) => slug),
    ['polski-szkic', 'cesky-published', 'only-draft'],
  )
  assert.deepEqual(
    planSlugs([...rows].reverse()),
    plans.map((plan) => ({
      ...plan,
      rows: [...plan.rows].reverse(),
    })),
  )
})

test('resolves collisions per document, prioritizes Polish, and is idempotent', () => {
  const rows = [
    row(1, 'a', 'cs', 'Same'),
    row(2, 'b', 'pl', 'Same'),
    row(3, 'b', 'cs', 'Translation'),
    row(4, 'c', 'pl', 'Same'),
    row(5, 'd', 'pl', 'Same-1'),
  ]
  const plans = planSlugs(rows)
  assert.deepEqual(
    plans.map(({ slug }) => slug),
    ['same', 'same-1', 'same-1-1', 'same-2'],
  )
  const repaired = plans.flatMap((plan) => plan.rows.map((item) => ({ ...item, slug: plan.slug })))
  assert.ok(planSlugs(repaired).every((plan) => !plan.changed))
})

test('rejects unusable source titles instead of silently falling back from Polish', () => {
  for (const title of ['', '  ', '!!!', null, 'a'.repeat(256)]) {
    assert.throws(
      () => planSlugs([row(1, 'a', 'cs', 'Usable translation'), row(2, 'a', 'pl', title)]),
      /source title|empty slug|longer than/,
    )
  }
})

const collections = [
  { endpoint: '/api/events', titleField: 'name', localized: true, draftAndPublish: true },
  { endpoint: '/api/pages', titleField: 'title', localized: true, draftAndPublish: true },
  { endpoint: '/api/aktywny-emeryts', titleField: 'title', localized: true, draftAndPublish: false },
]

function mockCms(options = {}) {
  const data = {
    '/api/events': [
      { id: 1, documentId: 'a', locale: 'cs', name: 'Cesky draft', slug: 'broken', publishedAt: null },
      { id: 2, documentId: 'a', locale: 'cs', name: 'Cesky published', slug: 'broken', publishedAt: '2020-01-01' },
      { id: 3, documentId: 'a', locale: 'pl', name: 'Nowy tytul', slug: 'broken', publishedAt: null },
      { id: 4, documentId: 'a', locale: 'pl', name: 'Polski tytul', slug: 'broken', publishedAt: '2020-01-01' },
      { id: 5, documentId: 'b', locale: 'pl', name: 'Drugi', slug: 'wrong', publishedAt: null },
    ],
    '/api/pages': [
      { id: 10, documentId: 'c', locale: 'cs', title: 'Ceska strana', slug: 'old-page', publishedAt: null },
    ],
    '/api/aktywny-emeryts': [{ id: 20, documentId: 'd', locale: 'pl', title: 'Seniorzy', slug: 'old-senior' }],
  }
  if (options.swaps) {
    for (const entry of data['/api/events']) entry.slug = entry.documentId === 'a' ? 'drugi' : 'polski-tytul'
  }
  const original = structuredClone(data)
  const calls = []
  const logs = []
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
  const fetchImpl = async (input, init) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://cms.example.test')
    assert.equal(init.headers.Authorization, 'Bearer test-token')
    assert.equal(init.redirect, 'error')
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null })
    if (url.pathname === '/api/i18n/locales') return json([{ code: 'cs' }, { code: 'pl' }, { code: 'en' }])
    const collection = collections.find(
      (item) => url.pathname === item.endpoint || url.pathname.startsWith(`${item.endpoint}/`),
    )
    assert.ok(collection)
    const entries = data[collection.endpoint]
    const locale = url.searchParams.get('locale')
    const status = url.searchParams.get('status')
    if (init.method === 'GET') {
      if (options.invalidPages && collection.endpoint === '/api/pages') return json({ data: [] })
      const found = entries.filter(
        (entry) =>
          entry.locale === locale &&
          (!collection.draftAndPublish || Boolean(entry.publishedAt) === (status === 'published')),
      )
      const page = Number(url.searchParams.get('pagination[page]'))
      // Force multiple pages even for a tiny fixture.
      return json({
        data: found.slice(page - 1, page),
        meta: { pagination: { page, pageSize: 1, pageCount: found.length, total: found.length } },
      })
    }
    assert.equal(init.method, 'PUT')
    if (options.failPages && collection.endpoint === '/api/pages') return json({}, 500)
    const documentId = decodeURIComponent(url.pathname.slice(collection.endpoint.length + 1))
    const { data: payload } = JSON.parse(init.body)
    assert.deepEqual(Object.keys(payload), ['slug'])
    if (entries.some((entry) => entry.documentId !== documentId && entry.slug === payload.slug)) return json({}, 400)
    const draft = entries.find(
      (entry) =>
        entry.documentId === documentId &&
        entry.locale === locale &&
        (!collection.draftAndPublish || !entry.publishedAt),
    )
    assert.ok(draft, 'must not create new documents/locales')
    for (const entry of entries) {
      if (entry.documentId === documentId && (!collection.draftAndPublish || !entry.publishedAt)) {
        entry.slug = payload.slug
      }
    }
    let result = draft
    if (status === 'published') {
      const published = entries.find(
        (entry) => entry.documentId === documentId && entry.locale === locale && entry.publishedAt,
      )
      assert.ok(published, 'must not publish draft-only locales')
      Object.assign(published, draft, { id: published.id, publishedAt: '2026-11-15' })
      result = published
    }
    if (options.overrideSlug) result.slug = 'plugin-overrode-slug'
    const response = structuredClone(result)
    if (options.corruptAfterWrite && collection.endpoint === '/api/aktywny-emeryts') draft.slug = 'later-corruption'
    return json({ data: response })
  }
  return {
    data,
    original,
    calls,
    logs,
    config: {
      url: 'https://cms.example.test',
      token: 'test-token',
      collections,
      fetchImpl,
      log: (message) => logs.push(message),
    },
  }
}

test('API preview reads all locales, paginates both statuses, and never writes', async () => {
  const cms = mockCms()
  const plans = await regenerateSlugs(cms.config)
  assert.equal(plans.length, 3)
  assert.equal(plans[0].documents[0].slug, 'polski-tytul')
  assert.equal(plans[1].documents[0].slug, 'ceska-strana')
  assert.equal(plans[2].documents[0].slug, 'seniorzy')
  assert.ok(cms.calls.every((call) => call.method === 'GET'))
  assert.ok(cms.calls.some(({ url }) => url.searchParams.get('pagination[page]') === '2'))
  assert.equal(cms.calls[1].url.searchParams.get('locale'), 'pl')
  assert.ok(cms.logs.some((message) => message.includes('"fallback":true')))
  assert.deepEqual(cms.data, cms.original)
})

test('API apply updates Polish first and republishes only previously published locales', async () => {
  const cms = mockCms()
  await regenerateSlugs({ ...cms.config, apply: true })
  const writes = cms.calls.filter((call) => call.method === 'PUT')
  assert.equal(writes.length, 5)
  assert.deepEqual(
    writes.slice(0, 2).map(({ url }) => url.searchParams.get('locale')),
    ['pl', 'cs'],
  )
  assert.ok(writes.slice(0, 2).every(({ url }) => url.searchParams.get('status') === 'published'))
  assert.equal(writes[2].url.searchParams.get('status'), 'draft')
  assert.equal(writes[4].url.searchParams.has('status'), false)
  assert.ok(
    cms.data['/api/events'].filter((entry) => entry.documentId === 'a').every((entry) => entry.slug === 'polski-tytul'),
  )
  const published = cms.data['/api/events'].find((entry) => entry.locale === 'pl' && entry.publishedAt)
  assert.equal(published.name, 'Nowy tytul')
  assert.equal(cms.data['/api/pages'][0].publishedAt, null)
  assert.equal(cms.data['/api/aktywny-emeryts'][0].slug, 'seniorzy')
  assert.ok(cms.logs.some((message) => message.includes('NOT a transaction')))
})

test('API apply frees conflicting slugs, including published versions, before swapping them', async () => {
  const cms = mockCms({ swaps: true })
  await regenerateSlugs({ ...cms.config, apply: true })
  const writes = cms.calls.filter((call) => call.method === 'PUT')
  assert.ok(writes.slice(0, 3).every((call) => call.body.data.slug.startsWith('slug-repair-')))
  assert.equal(writes[3].body.data.slug, 'polski-tytul')
  assert.equal(writes[5].body.data.slug, 'drugi')
  assert.ok(cms.data['/api/events'].every((entry) => !entry.slug.startsWith('slug-repair-')))
})

test('invalid pagination in a later collection aborts before any API writes', async () => {
  const cms = mockCms({ invalidPages: true })
  await assert.rejects(regenerateSlugs({ ...cms.config, apply: true }), /Invalid paginated response/)
  assert.ok(cms.calls.every((call) => call.method === 'GET'))
})

test('API write failures stop later writes without pretending to roll back earlier updates', async () => {
  const cms = mockCms({ failPages: true })
  await assert.rejects(regenerateSlugs({ ...cms.config, apply: true }), /HTTP 500/)
  assert.equal(cms.data['/api/events'][0].slug, 'polski-tytul')
  assert.deepEqual(cms.data['/api/aktywny-emeryts'], cms.original['/api/aktywny-emeryts'])
})

test('API slug overrides and later shared-field changes fail verification', async () => {
  for (const options of [{ overrideSlug: true }, { corruptAfterWrite: true }]) {
    const cms = mockCms(options)
    await assert.rejects(regenerateSlugs({ ...cms.config, apply: true }), /verification failed/)
  }
})

test('rejects missing API credentials and unsafe CMS URLs without making requests', async () => {
  const cms = mockCms()
  await assert.rejects(regenerateSlugs({ ...cms.config, token: '' }), /STRAPI_V5_API_TOKEN/)
  await assert.rejects(regenerateSlugs({ ...cms.config, url: 'https://user:secret@example.test' }), /CMS URL/)
  assert.equal(cms.calls.length, 0)
})
