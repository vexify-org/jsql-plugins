/**
 * JSQL Echo Plugin
 * 
 * 简单的 Echo 测试插件——将输入原样返回。
 * 仅用于测试 PR Auto Review 流程。
 */

'use strict';

module.exports = {
  name: 'echo',
  version: '1.0.0',
  description: 'Echo plugin — returns input as output for testing',
  author: 'VBot',
  license: 'MIT',

  hooks: {
    beforeQuery(sql, params) {
      // 不拦截，只是观测
    },
    afterQuery(sql, params, opts, result) {
      // 不修改结果，只是观测
    }
  },

  install(engine, ctx) {
    // 无额外设置
  },

  api: {
    echo(value) {
      return value;
    },
    ping() {
      return 'pong';
    }
  }
};
