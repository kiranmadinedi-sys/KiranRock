const axios = require('axios');
const jwt = require('jsonwebtoken');

const userId = process.argv[2] || '83f08677-e55a-48d1-bd31-f5b56fa79c23';
const secret = 'your_jwt_secret';

const token = jwt.sign({ id: userId }, secret, { expiresIn: '1h' });

(async () => {
  try {
    const res = await axios.get('http://127.0.0.1:3001/api/trading/ledger', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    console.log('HTTP LEDGER RESPONSE STATUS:', res.status);
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    if (err.response) {
      console.error('HTTP', err.response.status, err.response.data);
    } else {
      console.error('ERR', err.message);
    }
  }
})();
