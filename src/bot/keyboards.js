'use strict';

/**
 * Keyboard reply utama. mainMenu() tanpa argumen = perilaku lama (Indonesia,
 * 5 tombol) agar kompatibel dengan test & tombol lama. mainMenu(lang) merender
 * label sesuai bahasa; callback/aksi memakai pencocokan label lintas bahasa.
 */
const LABELS = {
  input: { id: '📝 INPUT LEMBUR', en: '📝 OVERTIME ENTRY', 'zh-TW': '📝 輸入加班', vi: '📝 NHẬP TĂNG CA' },
  status: { id: '📋 Status Lembur Saya', en: '📋 My Overtime Status', 'zh-TW': '📋 我的加班狀態', vi: '📋 Trạng thái tăng ca của tôi' },
  history: { id: '📁 Riwayat Lembur', en: '📁 Overtime History', 'zh-TW': '📁 加班紀錄', vi: '📁 Lịch sử tăng ca' },
  profile: { id: '👤 Profil Saya', en: '👤 My Profile', 'zh-TW': '👤 我的個人資料', vi: '👤 Hồ sơ của tôi' },
  help: { id: '❓ Bantuan', en: '❓ Help', 'zh-TW': '❓ 說明', vi: '❓ Trợ giúp' },
  language: { id: '🌐 Bahasa', en: '🌐 Language', 'zh-TW': '🌐 語言', vi: '🌐 Ngôn ngữ' },
};

const ALL_LABELS = Object.values(LABELS).flatMap((m) => Object.values(m));

/**
 * mainMenu() tanpa argumen = keyboard lama 5 tombol (kompatibilitas test/label lama).
 * mainMenu(lang) = keyboard berbahasa + baris tombol 🌐 Bahasa (semua pengguna).
 */
const mainMenu = (lang = null) => {
  const pick = (m) => (lang && m[lang]) || m.id;
  const kb = [
    [pick(LABELS.input), pick(LABELS.status)],
    [pick(LABELS.history), pick(LABELS.profile)],
    [pick(LABELS.help)],
  ];
  if (lang) kb.push([pick(LABELS.language)]);
  return { keyboard: kb, resize_keyboard: true };
};

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

module.exports = { mainMenu, cb, REGEX_CB, LABELS, ALL_LABELS };
