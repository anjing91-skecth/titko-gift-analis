const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const supabase = require('./supabaseClient');

const FILE_PATH = path.join(__dirname, 'live_report.xlsx');
const SHEET_SUMMARY = 'Live Summary';
const SHEET_TOP = 'Top Spender';

// Helper: Buat workbook dan sheet jika belum ada
function ensureWorkbook() {
  let workbook, summarySheet, topSheet;
  if (fs.existsSync(FILE_PATH)) {
    workbook = XLSX.readFile(FILE_PATH);
    summarySheet = workbook.Sheets[SHEET_SUMMARY];
    topSheet = workbook.Sheets[SHEET_TOP];
    // Jika header lama belum ada kolom Peak Viewer, tambahkan manual (opsional, untuk migrasi)
    const rows = XLSX.utils.sheet_to_json(summarySheet, {header:1});
    if (rows[0] && rows[0].length === 6) {
      rows[0].push('Peak Viewer');
      XLSX.utils.sheet_add_aoa(summarySheet, [rows[0]], {origin:0});
      XLSX.writeFile(workbook, FILE_PATH);
    }
  } else {
    workbook = XLSX.utils.book_new();
    // Header Live Summary
    const summaryHeader = [[
      'Tanggal', 'Jam Mulai', 'Jam Selesai', 'Durasi', 'Akun', 'Total Diamond', 'Peak Viewer'
    ]];
    summarySheet = XLSX.utils.aoa_to_sheet(summaryHeader);
    XLSX.utils.book_append_sheet(workbook, summarySheet, SHEET_SUMMARY);
    // Header Top Spender
    const topHeader = [[
      'Tanggal', 'Akun',
      'Top1', 'Top2', 'Top3', 'Top4', 'Top5', 'Top6', 'Top7', 'Top8', 'Top9', 'Top10'
    ]];
    topSheet = XLSX.utils.aoa_to_sheet(topHeader);
    XLSX.utils.book_append_sheet(workbook, topSheet, SHEET_TOP);
    XLSX.writeFile(workbook, FILE_PATH);
  }
  return { workbook, summarySheet, topSheet };
}

/**
 * Menambah data ke sheet 'Live Summary'.
 * @param {Object} data - {tanggal, jamMulai, jamSelesai, durasi, akun, totalDiamond, peakViewer}
 */
function appendLiveSummary(data) {
  const { workbook } = ensureWorkbook();
  const ws = workbook.Sheets[SHEET_SUMMARY];
  const rows = XLSX.utils.sheet_to_json(ws, {header:1});
  const newRow = [
    data.tanggal,
    data.jamMulai,
    data.jamSelesai,
    data.durasi,
    data.akun,
    data.totalDiamond,
    data.peakViewer || 0
  ];
  XLSX.utils.sheet_add_aoa(ws, [newRow], {origin: -1});
  XLSX.writeFile(workbook, FILE_PATH);
  console.log('[Live Summary] Data ditulis:', newRow);
}

/**
 * Menambah data ke sheet 'Top Spender'.
 * @param {Object} data - {tanggal, akun, top10: [{username, points}, ...]}
 */
function appendTopSpenders(data) {
  const { workbook } = ensureWorkbook();
  const ws = workbook.Sheets[SHEET_TOP];
  // Format horizontal: tanggal, akun, top1, top2, ..., top10
  const topRow = [data.tanggal, data.akun];
  for (let i = 0; i < 10; i++) {
    if (data.top10 && data.top10[i]) {
      topRow.push(`${data.top10[i].username} (${data.top10[i].points})`);
    } else {
      topRow.push('-');
    }
  }
  XLSX.utils.sheet_add_aoa(ws, [topRow], {origin: -1});
  XLSX.writeFile(workbook, FILE_PATH);
  console.log('[Top Spender] Data ditulis:', topRow);
}

function toPgDate(dateStr) {
  // dateStr: '20/5/2025' => '2025-05-20'
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  return `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Simpan data live summary ke Supabase
 * @param {Object} data - {tanggal, jamMulai, jamSelesai, durasi, akun, totalDiamond, peakViewer}
 */
async function insertLiveSummaryToSupabase(data) {
  const tanggalPg = toPgDate(data.tanggal);
  const { error } = await supabase.from('live_summary').insert([
    {
      tanggal: tanggalPg,
      jam_mulai: data.jamMulai,
      jam_selesai: data.jamSelesai,
      durasi: data.durasi,
      akun: data.akun,
      total_diamond: data.totalDiamond,
      peak_viewer: data.peakViewer || 0
    }
  ]);
  if (error) {
    console.error('[Supabase] Gagal insert live_summary:', error.message);
  } else {
    console.log('[Supabase] Live summary berhasil disimpan');
  }
}

/**
 * Simpan data top spender ke Supabase
 * @param {Object} data - {tanggal, akun, top10: [{username, points}, ...]}
 */
async function insertTopSpendersToSupabase(data) {
  const tanggalPg = toPgDate(data.tanggal);
  const row = {
    tanggal: tanggalPg,
    akun: data.akun
  };
  for (let i = 0; i < 10; i++) {
    row[`top${i+1}`] = data.top10 && data.top10[i] ? `${data.top10[i].username} (${data.top10[i].points})` : '-';
  }
  const { error } = await supabase.from('top_spender').insert([row]);
  if (error) {
    console.error('[Supabase] Gagal insert top_spender:', error.message);
  } else {
    console.log('[Supabase] Top spender berhasil disimpan');
  }
}

module.exports = {
  appendLiveSummary,
  appendTopSpenders,
  insertLiveSummaryToSupabase,
  insertTopSpendersToSupabase
};
