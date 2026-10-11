'use strict';

const mainMenu = () => ({
  keyboard: [
    ['📝 INPUT LEMBUR', '📋 Status Lembur Saya'],
    ['📁 Riwayat Lembur', '👤 Profil Saya'],
    ['❓ Bantuan'],
  ],
  resize_keyboard: true,
});

const cb = {
  approveReg: (id) => `reg:ok:${id}`,
  rejectReg: (id) => `reg:no:${id}`,
  activate: (id) => `emp:on:${id}`,
  deactivate: (id) => `emp:off:${id}`,
  approveOv: (id) => `ov:ok:${id}`,
  rejectOv: (id) => `ov:no:${id}`,
};

const REGEX_CB = {
  regApprove: /^reg:ok:(\d+)$/,
  regReject: /^reg:no:(\d+)$/,
  empOn: /^emp:on:(\d+)$/,
  empOff: /^emp:off:(\d+)$/,
  ovApprove: /^ov:ok:(\d+)$/,
  ovReject: /^ov:no:(\d+)$/,
};

module.exports = { mainMenu, cb, REGEX_CB };
