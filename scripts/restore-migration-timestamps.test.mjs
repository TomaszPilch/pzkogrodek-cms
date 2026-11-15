import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { saveState } from './event-migration-state.mjs'
import { prepareTimestampRepair, timestampSql } from './restore-migration-timestamps.mjs'

const sourceUrl = 'https://old.example.test'
const targetUrl = 'https://new.example.test'
const dates = {
  createdAt: '2019-03-01T10:00:00.000Z',
  updatedAt: '2021-06-02T12:34:56.789Z',
  publishedAt: '2019-03-02T08:15:30.123Z',
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'migration-timestamps-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const eventStatePath = join(directory, 'events.json')
  const pageStatePath = join(directory, 'pages.json')
  await saveState(eventStatePath, {
    version: 1, sourceUrl, targetUrl, pending: null,
    documents: { 42: { documentId: 'event-document', locale: 'pl' } },
  })
  await saveState(pageStatePath, {
    version: 1, sourceUrl, targetUrl, contentType: 'api::page.page', pending: null,
    documents: { 16: { documentId: 'page-document', locale: 'cs' } },
  })
  const calls = []
  const options = {
    sourceUrl, targetUrl, sourceToken: 'test-source-token', eventStatePath, pageStatePath,
    fetchImpl: async (input, init) => {
      const url = new URL(input)
      calls.push({ url, init })
      assert.equal(url.origin, sourceUrl)
      assert.equal(init.method, 'GET')
      assert.equal(url.searchParams.get('publicationState'), 'live')
      assert.equal(url.searchParams.get('fields[0]'), 'createdAt')
      assert.equal(url.searchParams.get('fields[3]'), 'publishedAt')
      const page = url.pathname.includes('/pages/')
      assert.equal(url.pathname, page ? '/api/pages/16' : '/api/events/42')
      return new Response(JSON.stringify({
        data: { id: page ? 16 : 42, attributes: { ...dates, locale: page ? 'cs' : 'pl' } },
      }), { headers: { 'Content-Type': 'application/json' } })
    },
  }
  return { options, calls }
}

test('collects original dates for mapped events and pages without touching either CMS', async (t) => {
  const { options, calls } = await fixture(t)
  const { records, sql } = await prepareTimestampRepair(options)
  assert.deepEqual(records, [
    { collection: 'events', sourceId: '42', documentId: 'event-document', locale: 'pl', ...dates },
    { collection: 'pages', sourceId: '16', documentId: 'page-document', locale: 'cs', ...dates },
  ])
  assert.equal(calls.length, 2)
  assert.match(sql, /UPDATE "public"\."events" AS t/)
  assert.match(sql, /UPDATE "public"\."pages" AS t/)
  assert.match(sql, /SET created_at = s.created_at, updated_at = s.updated_at/)
  assert.equal((sql.match(/AND t.document_id = s.document_id AND t.locale = s.locale;/g) ?? []).length, 2)
  assert.match(sql, /count\(t.id\) FILTER \(WHERE t.published_at IS NOT NULL\) <> 1/)
  assert.match(sql, /t.created_at IS DISTINCT FROM s.created_at/)
  assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1)
  assert.ok(sql.endsWith('COMMIT;\n'))
  assert.doesNotMatch(sql, /SET slug|SET content/)
  assert.ok(sql.includes(dates.publishedAt))
  assert.match(sql, /published_at = CASE WHEN t.published_at IS NULL THEN NULL ELSE s.published_at END/)
  assert.match(sql, /t.published_at IS NOT NULL AND t.published_at IS DISTINCT FROM s.published_at/)
})

test('supports one collection and a custom PostgreSQL schema', async (t) => {
  const { options, calls } = await fixture(t)
  const { records, sql } = await prepareTimestampRepair({ ...options, type: 'pages', schema: 'cms' })
  assert.equal(records.length, 1)
  assert.equal(calls.length, 1)
  assert.match(sql, /UPDATE "cms"\."pages"/)
  assert.doesNotMatch(sql, /UPDATE "cms"\."events"/)
})

test('normalizes source timezone offsets and safely quotes mapped identifiers', () => {
  const sql = timestampSql([{
    collection: 'events', documentId: 'doc\'quote', locale: 'pl', ...dates,
    createdAt: '2019-03-01T11:00:00.000+01:00',
  }])
  assert.match(sql, /'doc''quote'/)
  assert.ok(sql.includes('\'2019-03-01T10:00:00.000Z\''))
  assert.throws(() => timestampSql([], 'public'), /No mapped records/)
  assert.throws(() => timestampSql([], 'public"; DROP TABLE events;--'), /Invalid PostgreSQL schema/)
  assert.throws(() => timestampSql([{ collection: 'other', documentId: 'doc', locale: 'pl', ...dates }]), /Invalid timestamp/)
  const row = { collection: 'pages', documentId: 'doc', locale: 'pl', ...dates }
  assert.throws(() => timestampSql([row, row]), /Multiple source records/)
  assert.throws(() => timestampSql([{ ...row, updatedAt: null }]), /invalid source updatedAt/)
  assert.throws(() => timestampSql([{ ...row, publishedAt: null }]), /invalid source publishedAt/)
  assert.throws(() => timestampSql([{ ...row, publishedAt: 'invalid' }]), /invalid source publishedAt/)
})

test('rejects missing source dates or changed source identity rather than guessing', async (t) => {
  const { options } = await fixture(t)
  for (const data of [
    { id: 42, attributes: { ...dates, locale: 'cs' } },
    { id: 41, attributes: { ...dates, locale: 'pl' } },
    { id: 42, attributes: { createdAt: dates.createdAt, locale: 'pl' } },
    { id: 42, attributes: { ...dates, publishedAt: null, locale: 'pl' } },
    { id: 42, attributes: { ...dates, publishedAt: undefined, locale: 'pl' } },
    null,
  ]) {
    await assert.rejects(prepareTimestampRepair({
      ...options, type: 'events',
      fetchImpl: async () => new Response(JSON.stringify({ data })),
    }))
  }
})

test('requires the correct existing state and blocks pending or empty mappings', async (t) => {
  const { options } = await fixture(t)
  await assert.rejects(prepareTimestampRepair({
    ...options, type: 'events', eventStatePath: options.pageStatePath,
  }), /content type/)
  await assert.rejects(prepareTimestampRepair({
    ...options, type: 'events', eventStatePath: join(dirname(options.eventStatePath), 'missing.json'),
  }), { code: 'ENOENT' })
  for (const pending of [null, { sourceId: 42 }]) {
    await saveState(options.eventStatePath, {
      version: 1, sourceUrl, targetUrl, documents: {}, pending,
    })
    await assert.rejects(prepareTimestampRepair({ ...options, type: 'events' }),
      pending ? /uncertain outcome/ : /No saved mappings/)
  }
})
