import { createSlug } from '../../../../functions/slug'

export default {
  async beforeCreate(event) {
    const { data } = event.params
    // @ts-ignore
    data.slug = await createSlug(strapi, 'api::gallery.gallery', data.name)
  },
}
