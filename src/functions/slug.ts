import slugify from 'slugify'

export const createSlug = async (strapi: any, path: string, title: string) => {
  const slug = slugify(title, { lower: true })
  const entities = await strapi.db.query(path).findMany({
    where: {
      slug: { $startsWith: slug },
    },
  })

  let nextIndex = 0
  let nextSlug = slug
  while (entities.some((e: any) => e.slug === nextSlug)) {
    nextIndex += 1
    nextSlug = `${slug}-${nextIndex}`
  }
  return nextSlug
}
