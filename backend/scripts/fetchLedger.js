const axios = require('axios');

const token = process.env.JWT_TOKEN;

(async () => {
  try {
    const res = await axios.get('http://127.0.0.1:3001/api/trading/ledger', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    if (err.response) {
      console.error('HTTP', err.response.status, err.response.data);
    } else {
      console.error('ERR', err.message);
    }
  }
})();