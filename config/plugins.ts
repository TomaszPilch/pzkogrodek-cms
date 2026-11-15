export default {
  'strapi-slug-creator': {
    enabled: true,
    config: {
      applyToContentTypes: ['api::aktywny-emeryt.aktywny-emeryt', 'api::event.event', 'api::page.page'],
      titleFields: {
        'api::aktywny-emeryt.aktywny-emeryt': 'title',
        'api::event.event': 'name',
        'api::page.page': 'title',
      },
    },
  },
}
