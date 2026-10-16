/**
 * JSQL Slug Plugin — 生成 URL slug
 */
'use strict';

module.exports = {
  name: 'slug',
  version: '1.0.0',
  description: 'URL slug generator plugin',
  author: 'VBot',
  license: 'MIT',
  hooks: {
    afterQuery(sql, params, opts, result) {
      // 纯观测，不修改
    }
  },
  install(engine, ctx) {},
  api: {
    slug(str) {
      return String(str)
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }
  }
};
