import { createSlug } from '../../../../functions/slug'

export default {
  async beforeCreate(event) {
    const { data } = event.params
    data.slug = await createSlug(strapi, 'api::event.event', data.name)
  },
}
