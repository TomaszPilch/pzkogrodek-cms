import MarkdownIt from 'markdown-it'
import { parseDocument } from 'htmlparser2'

const markdown = new MarkdownIt({ html: true })
const marks = {
  strong: 'bold', b: 'bold', em: 'italic', i: 'italic',
  u: 'underline', s: 'strikethrough', del: 'strikethrough', code: 'code',
}
const containers = new Set(['div', 'section', 'article'])
const inlineTags = new Set([...Object.keys(marks), 'span', 'a', 'br'])
const text = (value, formatting = {}) => ({ type: 'text', text: value, ...formatting })
const nonempty = (children) => children.length ? children : [text('')]
const ignored = (node) => node.type === 'comment' || node.name === 'style'
const meaningful = (node) => !ignored(node) && (node.type !== 'text' || node.data.trim())
const rawText = (node) => node.type === 'text' ? node.data : (node.children ?? []).map(rawText).join('')

export function contentUrl(value, baseUrl, image = false) {
  if (!value) throw new Error('Missing content URL')
  const url = new URL(value, baseUrl)
  const protocols = image ? ['https:', 'http:'] : ['https:', 'http:', 'mailto:', 'tel:', 'ftp:']
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new Error('Unsupported content URL protocol or embedded credentials')
  }
  return url.href
}

function checkNode(node) {
  if (node.attribs?.['data-embed']) {
    throw new Error(`HTML <${node.name}> has embedded content that Blocks cannot preserve`)
  }
}

function firstLinkHref(node) {
  if (ignored(node)) return undefined
  if (node.name === 'a' && node.attribs.href?.trim()) return node.attribs.href
  for (const child of node.children ?? []) {
    const href = firstLinkHref(child)
    if (href) return href
  }
}

function inline(nodes, baseUrl, formatting = {}, unwrapLinks = false) {
  return nodes.flatMap((node) => {
    if (ignored(node)) return []
    if (node.type === 'text') return [text(node.data.replace(/\s+/g, ' '), formatting)]
    checkNode(node)
    if (node.name === 'br') return [text('\n', formatting)]
    if (node.name === 'code') return [text(rawText(node), { ...formatting, code: true })]
    if (node.name === 'a') {
      const children = inline(node.children, baseUrl, formatting, true)
      if (unwrapLinks) return children
      const href = firstLinkHref(node)
      if (!href) return children
      return [{
        type: 'link', url: contentUrl(href, baseUrl),
        children: nonempty(children),
      }]
    }
    if (!inlineTags.has(node.name)) throw new Error(`Unsupported inline HTML <${node.name}>`)
    return inline(node.children, baseUrl, {
      ...formatting, ...(marks[node.name] ? { [marks[node.name]]: true } : {}),
    }, unwrapLinks)
  })
}

function paragraph(nodes, baseUrl) {
  const blocks = []
  let pending = []
  const flush = () => {
    if (pending.some(meaningful)) blocks.push({ type: 'paragraph', children: nonempty(inline(pending, baseUrl)) })
    pending = []
  }
  for (const node of nodes) {
    if (node.name === 'img') {
      flush()
      checkNode(node)
      blocks.push({
        type: 'image',
        image: {
          url: contentUrl(node.attribs.src, baseUrl, true),
          alternativeText: node.attribs.alt ?? '',
          caption: node.attribs.title ?? null,
        },
        children: [text('')],
      })
    } else {
      pending.push(node)
    }
  }
  flush()
  return blocks
}

function list(node, baseUrl) {
  if ((node.attribs.start && node.attribs.start !== '1') || Object.hasOwn(node.attribs, 'reversed')) {
    throw new Error('Blocks cannot preserve an ordered list starting at a number other than 1')
  }
  const children = []
  for (const item of node.children.filter(meaningful)) {
    if (item.name !== 'li') throw new Error('Unsupported list structure')
    checkNode(item)
    if (item.attribs.value) throw new Error('Blocks cannot preserve custom list numbering')
    let pending = []
    const flush = () => {
      if (pending.length) children.push({ type: 'list-item', children: pending })
      pending = []
    }
    for (const child of item.children) {
      if (ignored(child)) continue
      if (child.type === 'text' && !child.data.trim() && !pending.length) continue
      checkNode(child)
      if (child.name === 'ul' || child.name === 'ol') {
        flush()
        children.push(list(child, baseUrl))
      } else if (child.name === 'p') {
        if (pending.length) pending.push(text('\n'))
        pending.push(...inline(child.children, baseUrl))
      } else {
        pending.push(...inline([child], baseUrl))
      }
    }
    flush()
  }
  if (!children.length) throw new Error('Empty lists are unsupported by Blocks')
  return { type: 'list', format: node.name === 'ol' ? 'ordered' : 'unordered', children }
}

function blocks(nodes, baseUrl) {
  const result = []
  let pending = []
  const flush = () => {
    result.push(...paragraph(pending, baseUrl))
    pending = []
  }
  for (const node of nodes) {
    if (ignored(node)) continue
    checkNode(node)
    if (node.type === 'text' || inlineTags.has(node.name) || node.name === 'img') {
      pending.push(node)
      continue
    }
    flush()
    if (node.name === 'p') {
      const converted = paragraph(node.children, baseUrl)
      result.push(...(converted.length ? converted : [{ type: 'paragraph', children: [text('')] }]))
    } else if (/^h[1-6]$/.test(node.name)) {
      result.push({ type: 'heading', level: Number(node.name[1]), children: nonempty(inline(node.children, baseUrl)) })
    } else if (containers.has(node.name)) {
      result.push(...blocks(node.children, baseUrl))
    } else if (node.name === 'ul' || node.name === 'ol') {
      result.push(list(node, baseUrl))
    } else if (node.name === 'blockquote') {
      for (const child of blocks(node.children, baseUrl)) {
        if (child.type !== 'paragraph') throw new Error('Complex block quotes are unsupported')
        result.push({ type: 'quote', children: child.children })
      }
    } else if (node.name === 'pre') {
      const code = node.children.find((child) => child.name === 'code')
      const language = code?.attribs.class?.match(/(?:^|\s)language-(\S+)/)?.[1]
      result.push({
        type: 'code', ...(language ? { language } : {}),
        children: [text(rawText(node).replace(/\n$/, ''))],
      })
    } else {
      throw new Error(`Unsupported HTML <${node.name}>; convert it manually before migrating`)
    }
  }
  flush()
  return result
}

export function toBlocks(content, baseUrl) {
  if (content == null || content === '') return []
  if (typeof content !== 'string') throw new Error('Expected v4 content to be Markdown or HTML text')
  return blocks(parseDocument(markdown.render(content)).children, baseUrl)
}
