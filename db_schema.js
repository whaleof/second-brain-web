// db_schema.js - 写入前校验层（纯逻辑，无浏览器依赖，可 node 测试）
//
// 护栏：只校验"新写入"路径（add/put），不回溯老数据；校验失败抛明确 DBError。
// 设计原则（对齐工作台数据层正规化第二层）：
//   1. 白名单式轻校验——只在「类型明显错 / 必填确缺失」时拦，不要求所有字段齐全，
//      以免卡住正常功能（老数据照常读、UI 局部更新也能过）。
//   2. 逻辑与 IO 分离——抽成纯函数方便单测（对标 sync_core 做法）。
//   3. 明确错误码——前端据此给用户可读提示，而非静默吞掉或抛原生 Error。
//
// 加载方式（UMD）：浏览器 <script> 挂 window.SchemaValidator；node require 导出同名对象。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.SchemaValidator = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 明确错误码集合
  const CODES = {
    INVALID_INPUT: 'INVALID_INPUT',           // 数据不是对象或为空
    MISSING_REQUIRED: 'MISSING_REQUIRED',     // 必填字段缺失
    TYPE_MISMATCH: 'TYPE_MISMATCH',           // 字段类型错误
    VALUE_OUT_OF_RANGE: 'VALUE_OUT_OF_RANGE', // 数值越界
  };

  class DBError extends Error {
    constructor(code, message, detail) {
      super(message);
      this.name = 'DBError';
      this.code = code;
      this.detail = detail || null;
    }
  }

  // 各 store 的写入约束（轻量白名单：只在明显非法时拦）
  // require: 仅 add（新建）模式检查；type: add 和 put 都检查（传了就查类型）
  const STORE_RULES = {
    timeline_logs: {
      require: ['date', 'hour', 'content'],
      types: { date: 'string', hour: 'number', content: 'string' },
    },
    weight_records: {
      require: ['weight'],
      types: { weight: 'number' },
    },
    finance_records: {
      require: ['amount', 'type'],
      types: { amount: 'number', type: 'string' },
    },
    habit_logs: {
      // habitId 是 habits.id 的外键，实际为数字（store 主键 autoIncrement）；
      // 允许 number | string，避免误拦正常打卡写入（导致点圆圈无反应）。
      require: ['habitId', 'date'],
      types: { habitId: 'id', date: 'string' },
    },
    kv_store: {
      require: ['key'],
      types: { key: 'string' },
    },
  };

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function validateRecord(storeName, data, mode) {
    mode = mode === 'put' ? 'put' : 'add';
    if (!isPlainObject(data)) {
      return { ok: false, code: CODES.INVALID_INPUT, message: `写入 ${storeName} 的数据必须是对象` };
    }
    const rule = STORE_RULES[storeName];
    if (!rule) {
      // 无专门规则的 store：仅做基础合法性检查，不拦正常字段
      return { ok: true };
    }
    // 必填字段（仅新建 add 模式；put 更新可能只传部分字段）
    if (mode === 'add') {
      for (const f of rule.require) {
        const val = data[f];
        if (val === undefined || val === null || val === '') {
          return { ok: false, code: CODES.MISSING_REQUIRED, message: `${storeName}.${f} 是必填项，不能为空` };
        }
      }
    }
    // 类型检查（两种模式都查：传了某字段就必须是正确类型）
    for (const [f, t] of Object.entries(rule.types)) {
      const val = data[f];
      if (val === undefined || val === null) continue; // 缺失由 require 拦（add）或忽略（put）
      let bad = false;
      if (t === 'number') bad = typeof val !== 'number' || !isFinite(val);
      else if (t === 'string') bad = typeof val !== 'string';
      else if (t === 'id') bad = (typeof val !== 'number' && typeof val !== 'string') || (typeof val === 'number' && !isFinite(val));
      if (bad) {
        return { ok: false, code: CODES.TYPE_MISMATCH, message: `${storeName}.${f} 必须是 ${t} 类型` };
      }
    }
    // timeline_logs.hour 越界检查（0-23）——防 str/int 混写导致下游排序崩溃
    if (storeName === 'timeline_logs' && typeof data.hour === 'number') {
      if (data.hour < 0 || data.hour > 23) {
        return { ok: false, code: CODES.VALUE_OUT_OF_RANGE, message: `timeline_logs.hour 必须在 0-23 之间` };
      }
    }
    return { ok: true };
  }

  return { validateRecord, DBError, CODES };
});
