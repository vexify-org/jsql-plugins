/**
 * JSQL Hash Plugin — 简单的哈希计算插件
 */
'use strict';

module.exports = {
  name: 'hash',
  version: '1.0.0',
  description: 'Simple hash plugin for testing PR Auto Review',
  author: 'VBot',
  license: 'MIT',
  hooks: {
    afterQuery(sql, params, opts, result) {
      // 纯观测，不修改结果
    }
  },
  install(engine, ctx) {},
  api: {
    md5(str) {
      // 简单实现，不依赖 crypto
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
      }
      return Math.abs(h).toString(16);
    },
    sha1(str) {
      return this.md5(str + 'salt');
    }
  }
};
