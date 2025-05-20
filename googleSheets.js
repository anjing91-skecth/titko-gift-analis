const fs = require('fs');
const path = require('path');
const supabase = require('./supabaseClient');

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
 * @param {Object} data - {tanggal_mulai, jam_mulai, durasi_live, nama_akun, total_diamond, peak_viewer, session_id}
 */
async function insertLiveSummaryToSupabase(data) {
  const tanggalPg = toPgDate(data.tanggal_mulai);
  try {
    console.log('Insert live_summary:', {
      tanggal_mulai: tanggalPg,
      jam_mulai: data.jam_mulai,
      durasi_live: data.durasi_live,
      nama_akun: data.nama_akun,
      total_diamond: data.total_diamond,
      peak_viewer: data.peak_viewer || 0,
      session_id: data.session_id
    });
    const { error } = await supabase.from('live_summary').insert([{
      tanggal_mulai: tanggalPg,
      jam_mulai: data.jam_mulai,
      durasi_live: data.durasi_live,
      nama_akun: data.nama_akun,
      total_diamond: data.total_diamond,
      peak_viewer: data.peak_viewer || 0,
      session_id: data.session_id
    }]);
    
    if (error) {
      console.error(`[${data.nama_akun}] Gagal insert live_summary:`, error.message);
    } else {
      console.log(`[${data.nama_akun}] Live summary berhasil disimpan ke Supabase`);
    }
  } catch (e) {
    console.error(`[${data.nama_akun}] Error saat menyimpan live summary:`, e.message);
  }
}

/**
 * Simpan data top spender ke Supabase
 * @param {Object} data - {tanggal_live, jam_mulai, akun, session_id, top_spenders: [{username, points}, ...]}
 */
async function insertTopSpendersToSupabase(data) {
  const tanggalPg = toPgDate(data.tanggal_live);
  const row = {
    tanggal_live: tanggalPg,
    jam_mulai: data.jam_mulai,
    akun: data.akun,
    session_id: data.session_id
  };
  
  // Format top spender data
  for (let i = 0; i < 10; i++) {
    const spender = data.top_spenders[i] || { username: '-', points: 0 };
    row[`top${i+1}`] = `${spender.username} (${spender.points})`;
  }
  console.log('Insert top_spender:', row);
  // Hapus data lama jika ada (untuk sesi live yang sama)
  await supabase
    .from('top_spender')
    .delete()
    .match({ 
      session_id: data.session_id  // Use session_id as unique identifier
    });
    
  // Insert data baru
  const { error } = await supabase.from('top_spender').insert([row]);
  if (error) {
    console.error('[Supabase] Gagal insert top_spender:', error.message);
  } else {
    console.log(`[${data.akun}] Top spender berhasil disimpan ke Supabase`);
  }
}

module.exports = {
  insertLiveSummaryToSupabase,
  insertTopSpendersToSupabase
};
