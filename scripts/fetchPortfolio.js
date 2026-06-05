// fetchPortfolio.js
// Usage: node scripts/fetchPortfolio.js http://99.47.183.33:3000 user password
// Tries Basic Auth first, then JSON /api/login, then form /login. Prints portfolio response.

const [,, baseUrl, username, password] = process.argv;
if (!baseUrl || !username || !password) {
  console.error('Usage: node scripts/fetchPortfolio.js <baseUrl> <username> <password>');
  process.exit(2);
}

const fetchWithTimeout = (url, opts = {}, timeout = 15000) => {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeout))
  ]);
};

async function tryBasicAuth(url) {
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  const res = await fetchWithTimeout(url, { headers: { 'Authorization': `Basic ${token}` } });
  return res;
}

function extractCookies(setCookie) {
  if (!setCookie) return '';
  if (Array.isArray(setCookie)) setCookie = setCookie.join('; ');
  // Keep only name=value pairs
  return setCookie.split(',').map(s => s.split(';')[0].trim()).join('; ');
}

async function tryJsonLogin(base) {
  const loginUrl = new URL('/api/login', base).toString();
  const res = await fetchWithTimeout(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  }).catch(e => null);
  return res;
}

async function tryFormLogin(base) {
  const loginUrl = new URL('/login', base).toString();
  const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const res = await fetchWithTimeout(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  }).catch(e => null);
  return res;
}

async function fetchPortfolio(endUrl, opts = {}) {
  const res = await fetchWithTimeout(endUrl, opts);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text };
}

(async () => {
  try {
    console.log('Trying Basic Auth...');
    try {
      const basicRes = await tryBasicAuth(baseUrl + '/portfolio');
      if (basicRes && basicRes.status >= 200 && basicRes.status < 300) {
        console.log('\n--- Portfolio (Basic Auth successful) ---\n');
        console.log(await basicRes.text());
        return;
      } else {
        console.log('Basic Auth returned', basicRes ? basicRes.status : 'no response');
      }
    } catch (e) {
      console.log('Basic Auth error:', e.message);
    }

    console.log('\nTrying JSON /api/login...');
    const jsonLoginRes = await tryJsonLogin(baseUrl);
    if (jsonLoginRes && jsonLoginRes.status >= 200 && jsonLoginRes.status < 300) {
      const setCookie = jsonLoginRes.headers.get('set-cookie') || '';
      const cookies = extractCookies(setCookie);
      console.log('Login OK, fetching portfolio with cookies...');
      const portfolio = await fetchPortfolio(baseUrl + '/portfolio', { headers: { 'Cookie': cookies } });
      console.log('\n--- Portfolio (after /api/login) ---\n');
      console.log(portfolio.body);
      return;
    } else {
      console.log('/api/login returned', jsonLoginRes ? jsonLoginRes.status : 'no response');
    }

    console.log('\nTrying form /login...');
    const formRes = await tryFormLogin(baseUrl);
    if (formRes && (formRes.status === 302 || (formRes.status >=200 && formRes.status<300))) {
      const setCookie = formRes.headers.get('set-cookie') || '';
      const cookies = extractCookies(setCookie);
      console.log('Form login appears successful, fetching portfolio...');
      const portfolio = await fetchPortfolio(baseUrl + '/portfolio', { headers: { 'Cookie': cookies } });
      console.log('\n--- Portfolio (after form /login) ---\n');
      console.log(portfolio.body);
      return;
    } else {
      console.log('/login returned', formRes ? formRes.status : 'no response');
    }

    console.log('\nAll attempts failed. You can try the curl commands locally or paste the output here.');
  } catch (err) {
    console.error('Error:', err.message);
  }
})();
