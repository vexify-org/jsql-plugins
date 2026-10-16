/**
 * JSQL Capitalize Plugin
 */
'use strict';
module.exports = {
  name: 'capitalize',
  version: '1.0.0',
  description: 'Capitalize string plugin',
  author: 'VBot',
  license: 'MIT',
  hooks: { afterQuery() {} },
  install() {},
  api: {
    capitalize(str) {
      return String(str).replace(/\b\w/g, c => c.toUpperCase());
    }
  }
};
