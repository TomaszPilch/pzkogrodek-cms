import type { Schema, Struct } from '@strapi/strapi'

export interface PageEventDetail extends Struct.ComponentSchema {
  collectionName: 'components_page_event_details'
  info: {
    description: ''
    displayName: 'Detail imprezy'
  }
  attributes: {
    event: Schema.Attribute.Relation<'oneToOne', 'api::event.event'>
  }
}

export interface PageGallery extends Struct.ComponentSchema {
  collectionName: 'components_page_galleries'
  info: {
    description: ''
    displayName: 'Obrazki'
  }
  attributes: {
    gallery: Schema.Attribute.Media<'images', true>
  }
}

export interface PagePage extends Struct.ComponentSchema {
  collectionName: 'components_page_pages'
  info: {
    description: ''
    displayName: 'Text'
  }
  attributes: {
    text: Schema.Attribute.Blocks
  }
}

export interface PageYoutube extends Struct.ComponentSchema {
  collectionName: 'components_page_youtubes'
  info: {
    displayName: 'Youtube'
  }
  attributes: {
    url: Schema.Attribute.String & Schema.Attribute.Required
  }
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'page.event-detail': PageEventDetail
      'page.gallery': PageGallery
      'page.page': PagePage
      'page.youtube': PageYoutube
    }
  }
}
