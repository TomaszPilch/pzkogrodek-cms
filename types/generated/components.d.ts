import type { Schema, Attribute } from '@strapi/strapi'

export interface PageEventDetail extends Schema.Component {
  collectionName: 'components_page_event_details'
  info: {
    displayName: 'Detail imprezy'
    description: ''
  }
  attributes: {
    event: Attribute.Relation<'page.event-detail', 'oneToOne', 'api::event.event'>
  }
}

export interface PageGallery extends Schema.Component {
  collectionName: 'components_page_galleries'
  info: {
    displayName: 'Obrazki'
    description: ''
  }
  attributes: {
    gallery: Attribute.Media
  }
}

export interface PagePage extends Schema.Component {
  collectionName: 'components_page_pages'
  info: {
    displayName: 'Text'
    description: ''
  }
  attributes: {
    text: Attribute.RichText &
      Attribute.CustomField<
        'plugin::ckeditor5.CKEditor',
        {
          preset: 'toolbar'
        }
      >
  }
}

export interface PageYoutube extends Schema.Component {
  collectionName: 'components_page_youtubes'
  info: {
    displayName: 'Youtube'
  }
  attributes: {
    url: Attribute.String & Attribute.Required
  }
}

declare module '@strapi/types' {
  export module Shared {
    export interface Components {
      'page.event-detail': PageEventDetail
      'page.gallery': PageGallery
      'page.page': PagePage
      'page.youtube': PageYoutube
    }
  }
}
