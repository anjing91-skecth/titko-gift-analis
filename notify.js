const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Mengirim notifikasi WhatsApp via Fonnte ketika live selesai.
 * @param {Object} summary - Data ringkasan live TikTok.
 *   summary.username, summary.duration, summary.totalPoints, summary.topGivers
 */
async function sendNotification(summary) {
  // Format pesan sesuai permintaan
  const top3 = (summary.topGivers || []).slice(0, 3)
    .map((g, i) => `${g.username} ${g.points}pt`).join(' - ');
  const message = `nama akun: ${summary.username}\ndurasilive: ${summary.duration}\ntotal point: ${summary.totalPoints} diamond\ntop spender 1: ${top3}`;

  // Fonnte API
  const url = 'https://api.fonnte.com/send';
  const token = 'V8HeLKAisXDur4cCg9H5';
  const target = '628112030610';

  try {
    const res = await axios.post(url, {
      target,
      message
    }, {
      headers: {
        'Authorization': token
      }
    });
    console.log('WhatsApp notification sent via Fonnte:', res.data);
  } catch (error) {
    console.error('Failed to send WhatsApp notification:', error.message);
  }
}

/**
 * Kirim pesan WhatsApp custom via Fonnte
 * @param {string} message
 */
async function sendWhatsApp(message) {
  const url = 'https://api.fonnte.com/send';
  const token = 'V8HeLKAisXDur4cCg9H5';
  const target = '628112030610';
  try {
    const res = await axios.post(url, {
      target,
      message
    }, {
      headers: {
        'Authorization': token
      }
    });
    console.log('WhatsApp notification sent via Fonnte:', res.data);
  } catch (error) {
    console.error('Failed to send WhatsApp notification:', error.message);
  }
}

/**
 * Kirim notifikasi error ke WhatsApp via Fonnte, hanya sekali per error unik per hari.
 * @param {string} errorMsg
 */
async function sendErrorNotification(errorMsg) {
  const today = new Date().toISOString().slice(0, 10);
  const flagFile = path.join(__dirname, 'logs', `error-notif-${today}.flag`);
  if (fs.existsSync(flagFile)) return; // Sudah pernah kirim hari ini
  const message = `ALERT TikTok Monitor\nTgl: ${today}\nError: ${errorMsg}`;
  await module.exports.sendWhatsApp(message);
  fs.writeFileSync(flagFile, 'sent');
}

module.exports = {
  sendNotification,
  sendWhatsApp,
  sendErrorNotification
};
