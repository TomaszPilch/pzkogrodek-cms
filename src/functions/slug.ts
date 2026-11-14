import type { Core } from '@strapi/strapi'
import slugify from 'slugify'

export const createSlug = async (strapi: Core.Strapi, path: string, title: string) => {
  const slug = slugify(title, { lower: true, strict: true })
  const entities: { slug: string }[] = await strapi.db.query(path).findMany({
    where: {
      slug: { $startsWith: slug },
    },
  })

  let nextIndex = 0
  let nextSlug = slug
  while (entities.some((e) => e.slug === nextSlug)) {
    nextIndex += 1
    nextSlug = `${slug}-${nextIndex}`
  }
  return nextSlug
}
