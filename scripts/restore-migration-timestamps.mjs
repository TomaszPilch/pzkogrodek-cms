import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { loadState } from './event-migration-state.mjs'
import { apiClient } from './migrate-events.mjs'

const collections = {
  events: 'api::event.event',
  pages: 'api::page.page',
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new Error(`Missing or invalid source ${field}`)
  }
  return new Date(value).toISOString()
}

function literal(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid SQL value')
  return `'${value.replaceAll('\'', '\'\'')}'`
}

function cmsUrl(value) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CMS URL must not contain credentials, query strings or fragments')
  }
  return url.href.replace(/\/$/, '')
}

export function timestampSql(records, schema = 'public') {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema name')
  if (!records.length) throw new Error('No mapped records to repair')
  const seen = new Set()
  const values = records.map((record) => {
    if (!Object.hasOwn(collections, record.collection) || !record.documentId || !record.locale) {
      throw new Error('Invalid timestamp repair record')
    }
    const key = JSON.stringify([record.collection, record.documentId, record.locale])
    if (seen.has(key)) throw new Error('Multiple source records map to the same target document and locale')
    seen.add(key)
    return `  (${[
      record.collection, record.documentId, record.locale,
      timestamp(record.createdAt, 'createdAt'), timestamp(record.updatedAt, 'updatedAt'),
      timestamp(record.publishedAt, 'publishedAt'),
    ].map(literal).join(', ')})`
  })
  const statements = [
    '-- Run only against the new CMS PostgreSQL database, after backing it up and pausing writes.',
    '-- Repairs audit dates on both versions and publication dates on published rows. Drafts remain unpublished.',
    'BEGIN;',
    'SET LOCAL lock_timeout = \'10s\';',
    'SET LOCAL statement_timeout = \'5min\';',
    'SET LOCAL TIME ZONE \'UTC\';',
    'SET LOCAL standard_conforming_strings = on;',
    'CREATE TEMP TABLE migration_timestamp_repairs (',
    '  collection text NOT NULL, document_id text NOT NULL, locale text NOT NULL,',
    '  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, published_at timestamptz NOT NULL,',
    '  PRIMARY KEY (collection, document_id, locale)',
    ') ON COMMIT DROP;',
    'INSERT INTO migration_timestamp_repairs VALUES',
    `${values.join(',\n')};`,
  ]
  for (const collection of [...new Set(records.map((record) => record.collection))].sort()) {
    const table = `"${schema}"."${collection}"`
    statements.push(
      `LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE;`,
      'DO $repair$',
      'BEGIN',
      '  IF EXISTS (',
      '    SELECT s.document_id, s.locale',
      '    FROM migration_timestamp_repairs s',
      `    LEFT JOIN ${table} t ON t.document_id = s.document_id AND t.locale = s.locale`,
      `    WHERE s.collection = ${literal(collection)}`,
      '    GROUP BY s.document_id, s.locale',
      '    HAVING count(t.id) NOT BETWEEN 1 AND 2',
      '      OR count(t.id) FILTER (WHERE t.published_at IS NOT NULL) <> 1',
      '      OR count(t.id) FILTER (WHERE t.published_at IS NULL) > 1',
      '  ) THEN',
      `    RAISE EXCEPTION 'Timestamp repair aborted: ${collection} has missing or ambiguous mapped rows, or is no longer published';`,
      '  END IF;',
      'END;',
      '$repair$;',
      `UPDATE ${table} AS t`,
      'SET created_at = s.created_at, updated_at = s.updated_at,',
      '    published_at = CASE WHEN t.published_at IS NULL THEN NULL ELSE s.published_at END',
      'FROM migration_timestamp_repairs s',
      `WHERE s.collection = ${literal(collection)}`,
      '  AND t.document_id = s.document_id AND t.locale = s.locale;',
      'DO $repair$',
      'BEGIN',
      '  IF EXISTS (',
      `    SELECT 1 FROM ${table} t`,
      '    JOIN migration_timestamp_repairs s ON t.document_id = s.document_id AND t.locale = s.locale',
      `    WHERE s.collection = ${literal(collection)}`,
      '      AND (t.created_at IS DISTINCT FROM s.created_at OR t.updated_at IS DISTINCT FROM s.updated_at',
      '        OR (t.published_at IS NOT NULL AND t.published_at IS DISTINCT FROM s.published_at))',
      '  ) THEN',
      `    RAISE EXCEPTION 'Timestamp repair verification failed for ${collection}';`,
      '  END IF;',
      'END;',
      '$repair$;',
    )
  }
  statements.push('COMMIT;', '')
  return statements.join('\n')
}

export async function prepareTimestampRepair({
  sourceUrl, targetUrl, sourceToken, type = 'all', schema = 'public',
  eventStatePath = join('.migration-state', 'events.json'),
  pageStatePath = join('.migration-state', 'pages.json'),
  fetchImpl = fetch,
}) {
  sourceUrl = cmsUrl(sourceUrl)
  targetUrl = cmsUrl(targetUrl)
  if (sourceUrl === targetUrl) throw new Error('Source and target CMS URLs must differ')
  if (!sourceToken) throw new Error('Set STRAPI_V4_API_TOKEN')
  if (!['all', ...Object.keys(collections)].includes(type)) throw new Error('Type must be all, events or pages')
  const source = apiClient(sourceUrl, sourceToken, fetchImpl)
  const records = []
  for (const collection of type === 'all' ? Object.keys(collections) : [type]) {
    const statePath = collection === 'events' ? eventStatePath : pageStatePath
    // Unlike a new migration, timestamp repair requires an existing ID mapping.
    await access(statePath)
    const state = await loadState(statePath, sourceUrl, targetUrl, collections[collection])
    if (!Object.keys(state.documents).length) throw new Error(`No saved mappings for ${collection}`)
    for (const [sourceId, mapping] of Object.entries(state.documents)) {
      const { data } = await source(`/api/${collection}/${encodeURIComponent(sourceId)}`, {
        locale: mapping.locale, publicationState: 'live',
        'fields[0]': 'createdAt', 'fields[1]': 'updatedAt', 'fields[2]': 'locale',
        'fields[3]': 'publishedAt',
      })
      if (String(data?.id) !== sourceId || data.attributes?.locale !== mapping.locale) {
        throw new Error(`Source ${collection} ${sourceId} is missing or has a different locale`)
      }
      records.push({
        collection, sourceId, ...mapping,
        createdAt: timestamp(data.attributes.createdAt, 'createdAt'),
        updatedAt: timestamp(data.attributes.updatedAt, 'updatedAt'),
        publishedAt: timestamp(data.attributes.publishedAt, 'publishedAt'),
      })
    }
  }
  return { records, sql: timestampSql(records, schema) }
}

async function main() {
  const { values } = parseArgs({
    options: {
      type: { type: 'string', default: 'all' },
      schema: { type: 'string', default: 'public' },
      write: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    console.log('Usage: yarn migrate:timestamps [--type all|events|pages] [--schema public] [--write]\nReads original v4 timestamps and saved migration IDs. Default: preview only.\n--write creates .migration-state/restore-timestamps.sql; it does not execute SQL.\nSet STRAPI_V4_API_TOKEN. CMS URL and state path variables are documented in README.md.')
    return
  }
  const { records, sql } = await prepareTimestampRepair({
    sourceUrl: process.env.STRAPI_V4_URL || 'https://cms.pzkogrodek.cz',
    targetUrl: process.env.STRAPI_V5_URL || 'https://cms-new.pzkogrodek.cz',
    sourceToken: process.env.STRAPI_V4_API_TOKEN,
    eventStatePath: process.env.STRAPI_EVENT_MIGRATION_STATE || process.env.STRAPI_MIGRATION_STATE,
    pageStatePath: process.env.STRAPI_PAGE_MIGRATION_STATE,
    type: values.type, schema: values.schema,
  })
  console.log(`Prepared timestamps for ${records.length} mapped document locales.`)
  if (!values.write) {
    console.log('Preview only. No files or CMS data changed. Use --write to generate the PostgreSQL repair SQL.')
    return
  }
  const outputPath = join('.migration-state', 'restore-timestamps.sql')
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, sql, { mode: 0o600 })
  console.log(`Written ${outputPath}. Review it and run it only against the NEW CMS database after backing up and pausing writes. No SQL was executed.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Timestamp repair preparation stopped: ${error.message}`)
    process.exitCode = 1
  })
}
