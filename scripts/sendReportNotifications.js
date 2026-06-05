try {
  require('dotenv').config({ path: 'backend/.env' });
} catch (e) {
  // Fallback: simple .env parser if dotenv not installed in this environment
  const envPath = require('path').join(__dirname, '..', 'backend', '.env');
  try {
    const envRaw = require('fs').readFileSync(envPath, 'utf8');
    envRaw.split(/\r?\n/).forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const idx = line.indexOf('=');
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // Remove optional inline comments
      if (val.includes('#')) val = val.split('#')[0].trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && val && !process.env[key]) process.env[key] = val;
    });
    console.log('[.env] Loaded backend/.env via fallback parser');
  } catch (err) {
    console.warn('[.env] Could not load backend/.env:', err.message);
  }
}
const fs = require('fs');
const path = require('path');
const https = require('https');

async function findLatest(pattern) {
  const dir = path.join(__dirname);
  const files = fs.readdirSync(dir).filter(f => f.match(pattern));
  if (!files.length) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

(async function main(){
  try{
    const tradesFile = await findLatest(/^weekly-trades-.*\.csv$/);
    const holdingsFile = await findLatest(/^weekly-holdings-.*\.csv$/);
    if (!tradesFile && !holdingsFile) {
      console.error('No report files found in scripts/');
      process.exit(1);
    }

    // Telegram: send CSV contents as text (fallback to avoid multipart upload)
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;
    if (tgToken && tgChat) {
      try{
        const sendText = async (title, filePath) => {
          const content = require('fs').readFileSync(filePath, 'utf8');
          const max = 3800;
          let parts = [];
          if (content.length <= max) parts = [content];
          else {
            for (let i=0;i<content.length;i+=max) parts.push(content.slice(i,i+max));
          }
          for (let i=0;i<parts.length;i++){
            const codeBlock = '```' + parts[i] + '```';
            const text = `\u{1F4C3} ${title} (part ${i+1}/${parts.length})\n\n` + codeBlock;
            await sendTelegramMessage(tgToken, tgChat, text);
          }
        };
        if (tradesFile) {
          console.log('Sending trades CSV to Telegram (as text)...');
          await sendText('weekly-trades', tradesFile);
          console.log('Trades sent via Telegram');
        }
        if (holdingsFile) {
          console.log('Sending holdings CSV to Telegram (as text)...');
          await sendText('weekly-holdings', holdingsFile);
          console.log('Holdings sent via Telegram');
        }
      }catch(e){
        console.error('Telegram send failed:', e.message);
      }
    } else {
      console.warn('Telegram token/chat not configured; skipping Telegram');
    }

    // Email
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASSWORD;
    const emailTo = process.env.EMAIL_TO || process.env.EMAIL_USER;

    if (emailUser && emailPass && emailTo) {
      try{
        const transporter = nodemailer.createTransport({
          service: process.env.EMAIL_SERVICE || 'gmail',
          auth: { user: emailUser, pass: emailPass }
        });

        const attachments = [];
        if (tradesFile) attachments.push({ filename: path.basename(tradesFile), path: tradesFile });
        if (holdingsFile) attachments.push({ filename: path.basename(holdingsFile), path: holdingsFile });

        const info = await transporter.sendMail({
          from: emailUser,
          to: emailTo,
          subject: `Weekly Trading Report - ${new Date().toISOString().slice(0,10)}`,
          text: `Attached: ${attachments.map(a=>a.filename).join(', ')}`,
          attachments
        });
        console.log('Email sent:', info.messageId || info.response);
      }catch(e){
        console.error('Email send failed:', e.message);
      }
    } else {
      console.warn('Email creds or recipient not configured; skipping email');
    }

    console.log('Done');
  }catch(err){
    console.error('Error:', err.message);
    process.exit(1);
  }
})();

  function sendTelegramMessage(token, chatId, text) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const req = https.request(options, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try{
            const j = JSON.parse(body);
            if (j.ok) resolve(j);
            else reject(new Error('Telegram error: ' + JSON.stringify(j)));
          }catch(e){
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
