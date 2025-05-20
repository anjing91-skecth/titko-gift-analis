// Script untuk mengirim rangkuman harian ke WhatsApp via Fonnte setiap jam 8 pagi
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const notify = require('./notify');

function getTodaySummary() {
  const filePath = path.join(__dirname, 'live_report.xlsx');
  if (!fs.existsSync(filePath)) return null;
  const workbook = XLSX.readFile(filePath);
  const ws = workbook.Sheets['Live Summary'];
  if (!ws) return null;
  const rows = XLSX.utils.sheet_to_json(ws, {header:1});
  const header = rows[0];
  const today = new Date();
  const tglStr = today.toLocaleDateString('id-ID');
  // Ambil semua baris hari ini
  const dataHariIni = rows.filter((row, idx) => idx > 0 && row[0] === tglStr);
  if (dataHariIni.length === 0) return null;
  // Ambil juga top spender per sesi dari sheet Top Spender
  const wsTop = workbook.Sheets['Top Spender'];
  const rowsTop = wsTop ? XLSX.utils.sheet_to_json(wsTop, {header:1}) : [];
  // Map: key = tanggal+akun+jamMulai, value = [top1, top2, top3]
  const topMap = {};
  rowsTop.forEach((row, idx) => {
    if (idx === 0) return;
    // key: tanggal|akun
    const key = `${row[0]}|${row[1]}`;
    topMap[key] = [row[2] || '-', row[3] || '-', row[4] || '-'];
  });
  // Rangkuman per sesi
  const sesiList = dataHariIni.map(row => {
    const key = `${row[0]}|${row[4]}`;
    return {
      tanggal: row[0],
      jamMulai: row[1],
      jamSelesai: row[2],
      durasi: row[3],
      akun: row[4],
      totalDiamond: row[5],
      top3: (topMap[key] || ['-','-','-']).join(' | ')
    };
  });
  return {
    tanggal: tglStr,
    sesiList
  };
}

async function sendDailySummary() {
  const summary = getTodaySummary();
  if (!summary) {
    console.log('Tidak ada data live hari ini.');
    return;
  }
  // Format pesan WhatsApp
  let message = `*Rangkuman Live TikTok*\nTanggal: ${summary.tanggal}\n\n`;
  summary.sesiList.forEach((sesi, idx) => {
    message += `*Sesi ${idx+1}*\n`;
    message += `Akun: ${sesi.akun}\n`;
    message += `Mulai: ${sesi.jamMulai}  Selesai: ${sesi.jamSelesai}\n`;
    message += `Durasi: ${sesi.durasi}\n`;
    message += `Total Diamond: ${sesi.totalDiamond}\n`;
    message += `Top Spender: ${sesi.top3}\n\n`;
  });
  await notify.sendWhatsApp(message);
}

// Untuk dijalankan via cron setiap jam 8 pagi
if (require.main === module) {
  sendDailySummary();
}

module.exports = { sendDailySummary };
